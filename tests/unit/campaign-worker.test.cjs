const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

function loadTypeScript(file, dependencies) {
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const fallbackRequire = loaded.require.bind(loaded);
  loaded.require = (specifier) => dependencies[specifier] ?? fallbackRequire(specifier);
  loaded._compile(output, file);
  return loaded.exports;
}

const workerPath = path.resolve(__dirname, "../../src/server/campaigns/worker.ts");
const environmentNames = [
  "WHATSAPP_SENDS_ENABLED", "WHATSAPP_SEND_TIME_ZONE", "WHATSAPP_SEND_WINDOW_START",
  "WHATSAPP_SEND_WINDOW_END", "WHATSAPP_SEND_DAYS", "WHATSAPP_WORKER_BATCH_SIZE",
  "WHATSAPP_MIN_INTERVAL_MS", "META_APP_ID", "META_APP_SECRET",
  "META_WEBHOOK_VERIFY_TOKEN", "WHATSAPP_THROTTLE_BATCH", "WHATSAPP_THROTTLE_COOLDOWN_MINUTES",
];

function withEnvironment(values, run) {
  const previous = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  for (const name of environmentNames) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  return Promise.resolve().then(run).finally(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

const enabledEnvironment = {
  WHATSAPP_SENDS_ENABLED: "true",
  WHATSAPP_SEND_TIME_ZONE: "UTC",
  WHATSAPP_SEND_WINDOW_START: "00:00",
  WHATSAPP_SEND_WINDOW_END: "23:59",
  WHATSAPP_SEND_DAYS: "0,1,2,3,4,5,6",
  WHATSAPP_WORKER_BATCH_SIZE: "1",
  WHATSAPP_MIN_INTERVAL_MS: "1000",
  META_APP_ID: "555555",
  META_APP_SECRET: "test-secret",
  META_WEBHOOK_VERIFY_TOKEN: "test-verify-token",
};

class MetaApiError extends Error {
  constructor(message, definitiveRejection = false) {
    super(message);
    this.definitiveRejection = definitiveRejection;
  }
}

class CampaignStoreError extends Error {}

function workerFixture({ gateSequence = ["allowed", "allowed"], subscribed = true, send, throttle } = {}) {
  const records = [];
  const calls = [];
  const claimArgs = [];
  const throttleCalls = [];
  const recipient = {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    campaign_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    contact_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    recipient_e164: "+14165550124",
    state: "in_flight",
  };
  const campaign = {
    id: recipient.campaign_id,
    state: "running",
    waba_id: "111111",
    phone_number_id: "222222",
    template_id: "333333",
    template_name: "autumn_offer",
    template_language: "en_US",
    template_snapshot: { id: "333333", name: "autumn_offer", language: "en_US" },
    body_parameters: ["Alex"],
  };
  let gateIndex = 0;
  const store = {
    rpc: async (name, args) => {
      calls.push(name);
      if (name === "campaign_send_throttle") {
        throttleCalls.push(args);
        return { data: throttle ?? { allowed: 99, wait_until: null }, error: null };
      }
      if (name === "claim_whatsapp_campaign_recipients") {
        claimArgs.push(args);
        return { data: [recipient], error: null };
      }
      if (name === "whatsapp_campaign_send_gate") {
        const gate = gateSequence[Math.min(gateIndex, gateSequence.length - 1)];
        gateIndex += 1;
        return { data: gate, error: null };
      }
      if (name === "reserve_whatsapp_sender_slot") return { data: 0, error: null };
      if (name === "record_whatsapp_campaign_send_result") {
        records.push(args);
        return { data: recipient, error: null };
      }
      return { data: 0, error: null };
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: campaign, error: null }) }) }),
    }),
  };
  const worker = loadTypeScript(workerPath, {
    "../meta/client": {
      getConfiguredMetaIdentifiers: () => ({ wabaId: "111111", phoneNumberId: "222222" }),
      getMetaConfigurationStatus: () => ({ configured: true }),
      listMetaWebhookSubscriptions: async () => ({ isCurrentAppSubscribed: subscribed }),
      MetaApiError,
    },
    "../meta/templates": {
      sendApprovedMarketingTemplate: send ?? (async (input) => {
        await input.beforeSend();
        return { messageId: "wamid.test" };
      }),
    },
    "./store": {
      CampaignStoreError,
      getCampaignStore: () => store,
      mapClaimedRecipient: (value) => ({
        id: value.id, campaignId: value.campaign_id,
        contactId: value.contact_id, recipientE164: value.recipient_e164,
        state: value.state,
      }),
      mapWorkerCampaign: (value) => ({
        id: value.id, state: value.state, wabaId: value.waba_id,
        phoneNumberId: value.phone_number_id, templateId: value.template_id,
        templateName: value.template_name, templateLanguage: value.template_language,
        templateSnapshot: value.template_snapshot,
        bodyParameters: value.body_parameters,
        headerMediaUrl: value.header_media_url,
      }),
    },
  });
  return { worker, records, calls, claimArgs, throttleCalls };
}

test("worker refuses to claim without an explicit send policy", async () => {
  await withEnvironment({ WHATSAPP_SENDS_ENABLED: "true" }, async () => {
    const fixture = workerFixture();
    const tick = await fixture.worker.runCampaignWorkerTick();
    assert.equal(tick.enabled, false);
    assert.equal(tick.claimed, 0);
    assert.deepEqual(fixture.calls, []);
  });
});

test("send window follows configured local day and clock", async () => {
  await withEnvironment(enabledEnvironment, () => {
    const { worker } = workerFixture();
    const policy = worker.getCampaignWorkerReadiness();
    assert.equal(policy.enabled, true);
    assert.equal(worker.isWithinCampaignSendWindow(policy, new Date("2026-10-16T10:00:00Z")), true);
    assert.equal(worker.isWithinCampaignSendWindow(policy, new Date("2026-10-16T23:59:00Z")), false);
  });
});

test("worker records one accepted wamid after a final eligibility check", async () => {
  await withEnvironment(enabledEnvironment, async () => {
    const fixture = workerFixture();
    const tick = await fixture.worker.runCampaignWorkerTick();
    assert.equal(tick.outcomes.accepted, 1);
    assert.equal(fixture.calls.filter((name) => name === "whatsapp_campaign_send_gate").length, 2);
    assert.equal(fixture.records[0].p_state, "accepted");
    assert.equal(fixture.records[0].p_wamid, "wamid.test");
  });
});

test("worker passes the reviewed template snapshot to send preflight", async () => {
  await withEnvironment(enabledEnvironment, async () => {
    let snapshot;
    const fixture = workerFixture({ send: async (input) => {
      snapshot = input.expectedTemplateSnapshot;
      await input.beforeSend();
      return { messageId: "wamid.test" };
    } });
    await fixture.worker.runCampaignWorkerTick();
    assert.equal(snapshot.id, "333333");
  });
});

test("worker refuses to claim when this app's webhook subscription is unverified", async () => {
  await withEnvironment(enabledEnvironment, async () => {
    const fixture = workerFixture({ subscribed: false });
    const tick = await fixture.worker.runCampaignWorkerTick();
    assert.equal(tick.enabled, false);
    assert.equal(tick.claimed, 0);
    assert.equal(fixture.calls.includes("claim_whatsapp_campaign_recipients"), false);
  });
});

test("an opt-out detected by the final gate blocks the send", async () => {
  await withEnvironment(enabledEnvironment, async () => {
    let posted = false;
    const fixture = workerFixture({
      gateSequence: ["allowed", "suppressed"],
      send: async (input) => {
        await input.beforeSend();
        posted = true;
        return { messageId: "wamid.should-not-exist" };
      },
    });
    const tick = await fixture.worker.runCampaignWorkerTick();
    assert.equal(posted, false);
    assert.equal(tick.outcomes.suppressed, 1);
    assert.equal(fixture.records[0].p_state, "suppressed");
  });
});

test("ambiguous provider transport failure is parked as uncertain", async () => {
  await withEnvironment(enabledEnvironment, async () => {
    const fixture = workerFixture({
      send: async (input) => {
        await input.beforeSend();
        throw new MetaApiError("Meta request outcome uncertain", false);
      },
    });
    const tick = await fixture.worker.runCampaignWorkerTick();
    assert.equal(tick.outcomes.uncertain, 1);
    assert.equal(fixture.records[0].p_state, "uncertain");
    assert.equal(fixture.calls.filter((name) => name === "claim_whatsapp_campaign_recipients").length, 1);
  });
});

test("worker forwards headerMediaUrl to sendApprovedMarketingTemplate", async () => {
  await withEnvironment(enabledEnvironment, async () => {
    let capturedHeaderMediaUrl;
    const fixture = workerFixture({
      send: async (input) => {
        capturedHeaderMediaUrl = input.headerMediaUrl;
        await input.beforeSend();
        return { messageId: "wamid.media-test" };
      },
    });
    // Set header_media_url on campaign
    const store = fixture.worker; // worker runs tick
    const tick = await fixture.worker.runCampaignWorkerTick();
    assert.equal(tick.outcomes.accepted, 1);
  });
});

test("no throttle by default: the throttle is not consulted and the claim uses the batch size", async () => {
  await withEnvironment({ ...enabledEnvironment, WHATSAPP_WORKER_BATCH_SIZE: "5" }, async () => {
    const fixture = workerFixture();
    const tick = await fixture.worker.runCampaignWorkerTick();
    assert.equal(fixture.throttleCalls.length, 0);
    assert.equal(fixture.claimArgs[0].p_limit, 5);
    assert.equal(tick.throttledUntil, undefined);
  });
});

test("throttle caps the claim to the remaining allowance in the current batch", async () => {
  const env = { ...enabledEnvironment, WHATSAPP_WORKER_BATCH_SIZE: "5",
    WHATSAPP_THROTTLE_BATCH: "15", WHATSAPP_THROTTLE_COOLDOWN_MINUTES: "30" };
  await withEnvironment(env, async () => {
    const fixture = workerFixture({ throttle: { allowed: 2, wait_until: null } });
    await fixture.worker.runCampaignWorkerTick();
    assert.deepEqual(fixture.throttleCalls[0], { p_batch: 15, p_cooldown_minutes: 30 });
    assert.equal(fixture.claimArgs[0].p_limit, 2);
  });
});

test("throttle never raises the claim above the normal batch size", async () => {
  const env = { ...enabledEnvironment, WHATSAPP_WORKER_BATCH_SIZE: "5",
    WHATSAPP_THROTTLE_BATCH: "15", WHATSAPP_THROTTLE_COOLDOWN_MINUTES: "30" };
  await withEnvironment(env, async () => {
    const fixture = workerFixture({ throttle: { allowed: 15, wait_until: null } });
    await fixture.worker.runCampaignWorkerTick();
    assert.equal(fixture.claimArgs[0].p_limit, 5);
  });
});

test("during the cooldown nothing is claimed or sent and the end time is reported", async () => {
  const env = { ...enabledEnvironment, WHATSAPP_THROTTLE_BATCH: "15", WHATSAPP_THROTTLE_COOLDOWN_MINUTES: "30" };
  await withEnvironment(env, async () => {
    const until = "2026-10-23T15:30:00+00:00";
    const fixture = workerFixture({ throttle: { allowed: 0, wait_until: until } });
    const tick = await fixture.worker.runCampaignWorkerTick();
    assert.equal(tick.enabled, true);
    assert.equal(tick.claimed, 0);
    assert.equal(tick.throttledUntil, until);
    assert.equal(fixture.claimArgs.length, 0);
    assert.equal(fixture.records.length, 0);
    assert.equal(fixture.calls.includes("whatsapp_campaign_send_gate"), false);
  });
});

test("an invalid or half-set throttle disables sending instead of sending unthrottled", async () => {
  for (const partial of [
    { WHATSAPP_THROTTLE_BATCH: "15" },
    { WHATSAPP_THROTTLE_COOLDOWN_MINUTES: "30" },
    { WHATSAPP_THROTTLE_BATCH: "0", WHATSAPP_THROTTLE_COOLDOWN_MINUTES: "30" },
    { WHATSAPP_THROTTLE_BATCH: "15", WHATSAPP_THROTTLE_COOLDOWN_MINUTES: "abc" },
    { WHATSAPP_THROTTLE_BATCH: "15", WHATSAPP_THROTTLE_COOLDOWN_MINUTES: "5000" },
  ]) {
    await withEnvironment({ ...enabledEnvironment, ...partial }, async () => {
      const fixture = workerFixture();
      const tick = await fixture.worker.runCampaignWorkerTick();
      assert.equal(tick.enabled, false, JSON.stringify(partial));
      assert.match(tick.reason, /throttle/i);
      assert.equal(fixture.claimArgs.length, 0);
    });
  }
});

test("a malformed throttle response fails the tick without claiming", async () => {
  const env = { ...enabledEnvironment, WHATSAPP_THROTTLE_BATCH: "15", WHATSAPP_THROTTLE_COOLDOWN_MINUTES: "30" };
  await withEnvironment(env, async () => {
    const fixture = workerFixture({ throttle: { allowed: "lots" } });
    await assert.rejects(() => fixture.worker.runCampaignWorkerTick(), /throttle/i);
    assert.equal(fixture.claimArgs.length, 0);
  });
});

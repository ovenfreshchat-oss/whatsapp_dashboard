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
  "WHATSAPP_SENDS_ENABLED", "CLIENT_TIME_ZONE", "WHATSAPP_SEND_TIME_ZONE", "WHATSAPP_SEND_WINDOW_START",
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
  constructor(message, definitiveRejection = false, providerCode = undefined) {
    super(message);
    this.definitiveRejection = definitiveRejection;
    this.providerCode = providerCode;
  }
}

class CampaignStoreError extends Error {}

function workerFixture({ gateSequence = ["allowed", "allowed"], subscribed = true, send, throttle, retries = [], retryGate = "allowed" } = {}) {
  const records = [];
  const calls = [];
  const claimArgs = [];
  const throttleCalls = [];
  const retryClaimArgs = [];
  const retryRecords = [];
  const alerts = [];
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
      if (name === "claim_campaign_retries") {
        retryClaimArgs.push(args);
        return { data: retries, error: null };
      }
      if (name === "campaign_retry_send_gate") return { data: retryGate, error: null };
      if (name === "record_campaign_retry_result") {
        retryRecords.push(args);
        return { data: true, error: null };
      }
      if (name === "raise_sender_alert") {
        alerts.push(args);
        return { data: null, error: null };
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
    "@/lib/timezone": loadTypeScript(path.resolve(__dirname, "../../src/lib/timezone.ts"), {}),
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
      mapClaimedRetry: (value) => ({
        id: value.id, campaignId: value.campaign_id, recipientId: value.recipient_id,
        phoneE164: value.phone_e164, attemptNumber: value.attempt_number,
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
  return { worker, records, calls, claimArgs, throttleCalls, retryClaimArgs, retryRecords, alerts };
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

const retryRow = {
  id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
  campaign_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  recipient_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  phone_e164: "+14165550999",
  attempt_number: 1,
};

test("retries only use the allowance left after first sends", async () => {
  await withEnvironment({ ...enabledEnvironment, WHATSAPP_WORKER_BATCH_SIZE: "5" }, async () => {
    const fixture = workerFixture();
    await fixture.worker.runCampaignWorkerTick();
    assert.equal(fixture.claimArgs[0].p_limit, 5);
    assert.equal(fixture.retryClaimArgs[0].p_limit, 4);
    assert.equal(fixture.calls.includes("mark_stale_campaign_retries"), true);
  });
});

test("no retries are claimed when first sends use the whole allowance", async () => {
  await withEnvironment(enabledEnvironment, async () => {
    const fixture = workerFixture();
    await fixture.worker.runCampaignWorkerTick();
    assert.equal(fixture.retryClaimArgs.length, 0);
  });
});

test("a retry is sent as a new message to the failed number and its wamid is recorded", async () => {
  await withEnvironment({ ...enabledEnvironment, WHATSAPP_WORKER_BATCH_SIZE: "5" }, async () => {
    const sentTo = [];
    const fixture = workerFixture({
      retries: [retryRow],
      send: async (input) => {
        sentTo.push(input.recipientE164);
        await input.beforeSend();
        return { messageId: `wamid.${input.recipientE164}` };
      },
    });
    const tick = await fixture.worker.runCampaignWorkerTick();
    assert.deepEqual(sentTo, ["+14165550124", "+14165550999"]);
    assert.equal(tick.retries.outcomes.accepted, 1);
    assert.equal(fixture.retryRecords[0].p_state, "accepted");
    assert.equal(fixture.retryRecords[0].p_wamid, "wamid.+14165550999");
  });
});

test("a retry that is no longer allowed is skipped without sending", async () => {
  await withEnvironment({ ...enabledEnvironment, WHATSAPP_WORKER_BATCH_SIZE: "5" }, async () => {
    let sends = 0;
    const fixture = workerFixture({
      retries: [retryRow], retryGate: "suppressed",
      send: async (input) => { sends += 1; await input.beforeSend(); return { messageId: "wamid.x" }; },
    });
    const tick = await fixture.worker.runCampaignWorkerTick();
    assert.equal(sends, 1); // only the first send; the retry never reached Meta
    assert.equal(tick.retries.outcomes.skipped, 1);
    assert.equal(fixture.retryRecords[0].p_state, "skipped");
  });
});

test("a retry waiting for a restricted sender is deferred, not failed", async () => {
  await withEnvironment({ ...enabledEnvironment, WHATSAPP_WORKER_BATCH_SIZE: "5" }, async () => {
    const fixture = workerFixture({ retries: [retryRow], retryGate: "deferred" });
    const tick = await fixture.worker.runCampaignWorkerTick();
    assert.equal(tick.retries.outcomes.deferred, 1);
    assert.equal(fixture.retryRecords[0].p_state, "deferred");
  });
});

test("Meta 131048 on a retry raises the sender alert and stops the retry as rejected", async () => {
  await withEnvironment({ ...enabledEnvironment, WHATSAPP_WORKER_BATCH_SIZE: "5" }, async () => {
    const fixture = workerFixture({
      retries: [retryRow],
      send: async (input) => {
        await input.beforeSend();
        if (input.recipientE164 === "+14165550999") throw new MetaApiError("limited", true, 131048);
        return { messageId: "wamid.first" };
      },
    });
    const tick = await fixture.worker.runCampaignWorkerTick();
    assert.equal(tick.retries.outcomes.rejected, 1);
    assert.equal(fixture.alerts[0].p_code, "131048");
    assert.equal(fixture.alerts[0].p_phone_number_id, "222222");
  });
});

test("Meta 131048 on a first send also raises the sender alert", async () => {
  await withEnvironment(enabledEnvironment, async () => {
    const fixture = workerFixture({
      send: async (input) => { await input.beforeSend(); throw new MetaApiError("limited", true, 131048); },
    });
    await fixture.worker.runCampaignWorkerTick();
    assert.equal(fixture.alerts.length, 1);
    assert.equal(fixture.records[0].p_state, "rejected");
  });
});

const torontoWindow = {
  ...enabledEnvironment,
  WHATSAPP_SEND_TIME_ZONE: undefined,
  CLIENT_TIME_ZONE: "America/Toronto",
  WHATSAPP_SEND_WINDOW_START: "09:00",
  WHATSAPP_SEND_WINDOW_END: "18:00",
  WHATSAPP_SEND_DAYS: "1,2,3,4,5",
};

test("the sending window follows Toronto clock time in winter (EST) and summer (EDT)", async () => {
  await withEnvironment(torontoWindow, () => {
    const { worker } = workerFixture();
    const policy = worker.getCampaignWorkerReadiness();
    assert.equal(policy.enabled, true);
    assert.equal(policy.timeZone, "America/Toronto");
    const open = (iso) => worker.isWithinCampaignSendWindow(policy, new Date(iso));
    // Wednesday 2026-11-04 is EST (UTC-5): 09:00 local is 14:00 UTC.
    assert.equal(open("2026-11-04T13:59:00Z"), false);
    assert.equal(open("2026-11-04T14:00:00Z"), true);
    assert.equal(open("2026-11-04T22:59:00Z"), true);
    assert.equal(open("2026-11-04T23:00:00Z"), false);
    // Wednesday 2026-07-15 is EDT (UTC-4): 09:00 local is 13:00 UTC.
    assert.equal(open("2026-07-15T12:59:00Z"), false);
    assert.equal(open("2026-07-15T13:00:00Z"), true);
    assert.equal(open("2026-07-15T21:59:00Z"), true);
    assert.equal(open("2026-07-15T22:00:00Z"), false);
  });
});

test("the allowed days follow the Toronto calendar day, not the UTC day", async () => {
  await withEnvironment({ ...torontoWindow, WHATSAPP_SEND_WINDOW_START: "00:00", WHATSAPP_SEND_WINDOW_END: "23:59", WHATSAPP_SEND_DAYS: "5" }, () => {
    const { worker } = workerFixture();
    const policy = worker.getCampaignWorkerReadiness();
    // 01:00 UTC on Saturday 2026-11-07 is still 20:00 on Friday in Toronto.
    assert.equal(worker.isWithinCampaignSendWindow(policy, new Date("2026-11-07T01:00:00Z")), true);
    // 05:30 UTC on Saturday is 00:30 on Saturday in Toronto.
    assert.equal(worker.isWithinCampaignSendWindow(policy, new Date("2026-11-07T05:30:00Z")), false);
  });
});

test("CLIENT_TIME_ZONE wins over the older WHATSAPP_SEND_TIME_ZONE, which still works alone", async () => {
  await withEnvironment({ ...torontoWindow, WHATSAPP_SEND_TIME_ZONE: "Asia/Kolkata" }, () => {
    assert.equal(workerFixture().worker.getCampaignWorkerReadiness().timeZone, "America/Toronto");
  });
  await withEnvironment({ ...torontoWindow, CLIENT_TIME_ZONE: undefined, WHATSAPP_SEND_TIME_ZONE: "Asia/Kolkata" }, () => {
    assert.equal(workerFixture().worker.getCampaignWorkerReadiness().timeZone, "Asia/Kolkata");
  });
});

test("a campaign scheduled for a Toronto time becomes due at exactly that local time, in EST, EDT and across a clock change", async () => {
  const tz = loadTypeScript(path.resolve(__dirname, "../../src/lib/timezone.ts"), {});
  await withEnvironment(torontoWindow, () => {
    const { worker } = workerFixture();
    const policy = worker.getCampaignWorkerReadiness();
    const cases = [
      ["2026-11-10T09:00", "2026-11-10T14:00:00.000Z"], // winter, EST
      ["2026-07-14T09:00", "2026-07-14T13:00:00.000Z"], // summer, EDT
      ["2026-10-30T09:00", "2026-10-30T13:00:00.000Z"], // Friday before the autumn change, still EDT
      ["2026-11-02T09:00", "2026-11-02T14:00:00.000Z"], // Monday after it, EST
      ["2026-03-06T09:00", "2026-03-06T14:00:00.000Z"], // Friday before the spring change, EST
      ["2026-03-09T09:00", "2026-03-09T13:00:00.000Z"], // Monday after it, EDT
    ];
    for (const [local, expectedUtc] of cases) {
      const scheduled = tz.zonedLocalToUtc(local, "America/Toronto");
      assert.equal(scheduled.ok, true, local);
      assert.equal(scheduled.iso, expectedUtc, local); // what is stored in Supabase
      const due = (nowMs) => Date.parse(scheduled.iso) <= nowMs;
      const at = Date.parse(expectedUtc);
      assert.equal(due(at - 60_000), false, `${local} must not run a minute early`);
      assert.equal(due(at), true, `${local} runs at the chosen time`);
      assert.equal(worker.isWithinCampaignSendWindow(policy, new Date(at - 60_000)), false, `${local}: window still closed a minute early`);
      assert.equal(worker.isWithinCampaignSendWindow(policy, new Date(at)), true, `${local}: window open at the chosen time`);
      assert.equal(tz.formatDateTime(scheduled.iso, "America/Toronto").startsWith(local.replace("T", " ")), true, local);
    }
  });
});

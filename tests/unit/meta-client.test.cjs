const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

// Compile these server modules in memory so the tests need no extra test runner.
function loadTypeScript(file, dependencies = {}) {
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
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

const metaDir = path.resolve(__dirname, "../../src/server/meta");
const client = loadTypeScript(path.join(metaDir, "client.ts"));
const templates = loadTypeScript(path.join(metaDir, "templates.ts"), { "./client": client });
const environmentNames = [
  "META_SYSTEM_USER_ACCESS_TOKEN",
  "META_WABA_ID",
  "META_PHONE_NUMBER_ID",
  "META_GRAPH_API_VERSION",
  "META_APP_ID",
];
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
const originalFetch = global.fetch;

function configure() {
  process.env.META_SYSTEM_USER_ACCESS_TOKEN = "test-token";
  process.env.META_WABA_ID = "111111";
  process.env.META_PHONE_NUMBER_ID = "222222";
  process.env.META_GRAPH_API_VERSION = "v25.0";
  delete process.env.META_APP_ID;
}

function restore() {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  global.fetch = originalFetch;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function template(status = "APPROVED", name = "autumn_offer") {
  return {
    id: name === "autumn_offer" ? "333333" : "444444",
    name,
    language: "en_US",
    category: "MARKETING",
    status,
    components: [{ type: "BODY", text: "Hello {{1}}" }],
  };
}

function graphFixture({ templateStatus = "APPROVED", templateOverride, sendResponse, sendError } = {}) {
  const calls = [];
  global.fetch = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    if (parsed.pathname === "/v25.0/111111") return json({ id: "111111", name: "Test WABA" });
    if (parsed.pathname === "/v25.0/111111/phone_numbers") {
      return json({ data: [{ id: "222222", display_phone_number: "+14165550123" }] });
    }
    if (parsed.pathname === "/v25.0/111111/message_templates") {
      return json({ data: [templateOverride ?? template(templateStatus)] });
    }
    if (parsed.pathname === "/v25.0/222222/messages") {
      if (sendError) throw sendError;
      return sendResponse ?? json({ messages: [{ id: "wamid.test-123" }] });
    }
    throw new Error(`Unexpected test URL: ${parsed.pathname}`);
  };
  return calls;
}

test("configuration reports missing and invalid fields without exposing values", () => {
  try {
    for (const name of environmentNames) delete process.env[name];
    assert.deepEqual(client.getMetaConfigurationStatus().missing, environmentNames.slice(0, 4));
    configure();
    process.env.META_WABA_ID = "bad/id";
    process.env.META_GRAPH_API_VERSION = "latest";
    assert.deepEqual(client.getMetaConfigurationStatus().invalid, ["META_WABA_ID", "META_GRAPH_API_VERSION"]);
    assert.equal(client.getMetaConfigurationStatus().configured, false);
  } finally {
    restore();
  }
});

test("template sync follows Graph cursors and returns the complete normalized list", async () => {
  try {
    configure();
    const afterValues = [];
    global.fetch = async (url) => {
      const after = new URL(url).searchParams.get("after");
      afterValues.push(after);
      return after
        ? json({ data: [template("PAUSED", "winter_offer")] })
        : json({
            data: [template()],
            paging: { next: "https://untrusted.invalid/page", cursors: { after: "cursor-2" } },
          });
    };
    const snapshot = await templates.syncMetaTemplates();
    assert.deepEqual(afterValues, [null, "cursor-2"]);
    assert.deepEqual(snapshot.templates.map((item) => item.name), ["autumn_offer", "winter_offer"]);
    assert.equal(snapshot.templates[0].components[0].text, "Hello {{1}}");
  } finally {
    restore();
  }
});

test("webhook subscription matches only a configured app ID", async () => {
  try {
    configure();
    global.fetch = async () => json({
      data: [{ whatsapp_business_api_data: { id: "555555", name: "Test app" } }],
    });
    assert.equal((await client.listMetaWebhookSubscriptions()).isCurrentAppSubscribed, null);
    process.env.META_APP_ID = "555555";
    assert.equal((await client.listMetaWebhookSubscriptions()).isCurrentAppSubscribed, true);
  } finally {
    restore();
  }
});

test("test send accepts an approved marketing template and rejects a paused one before POST", async () => {
  try {
    configure();
    let calls = graphFixture();
    const accepted = await templates.sendApprovedTemplateTest({
      recipientE164: "+14165550124",
      templateName: "autumn_offer",
      languageCode: "en_US",
      bodyParameters: ["Alex"],
    });
    assert.equal(accepted.messageId, "wamid.test-123");
    const posts = calls.filter((call) => call.options.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(JSON.parse(posts[0].options.body).template.components[0].parameters[0].text, "Alex");
    assert.equal(Object.hasOwn(JSON.parse(posts[0].options.body).template.components[0].parameters[0], "parameter_name"), false);

    calls = graphFixture({ templateStatus: "PAUSED" });
    await assert.rejects(
      () => templates.sendApprovedTemplateTest({
        recipientE164: "+14165550124",
        templateName: "autumn_offer",
        languageCode: "en_US",
        bodyParameters: ["Alex"],
      }),
      (error) => error instanceof client.MetaApiError && error.definitiveRejection,
    );
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 0);
  } finally {
    restore();
  }
});

test("named body values follow template order and include parameter_name in the send payload", async () => {
  try {
    configure();
    const named = {
      ...template(),
      components: [{ type: "BODY", text: "Hello {{text}}, {{offer}} is ready for {{text}}." }],
    };
    const calls = graphFixture({ templateOverride: named });
    const synced = (await templates.syncMetaTemplates()).templates[0];
    assert.deepEqual(templates.parseTemplateBodyParameters(synced.components[0].text), {
      format: "named",
      keys: ["text", "offer"],
    });
    const accepted = await templates.sendApprovedMarketingTemplate({
      recipientE164: "+14165550124",
      templateName: "autumn_offer",
      languageCode: "en_US",
      expectedTemplateId: "333333",
      expectedTemplateSnapshot: synced,
      bodyParameters: ["Alex", "weekend offer"],
    });
    assert.equal(accepted.messageId, "wamid.test-123");
    const posts = calls.filter((call) => call.options.method === "POST");
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(posts[0].options.body).template.components[0].parameters, [
      { type: "text", parameter_name: "text", text: "Alex" },
      { type: "text", parameter_name: "offer", text: "weekend offer" },
    ]);
  } finally {
    restore();
  }
});

test("mixed or malformed body placeholders cannot be sent", async () => {
  try {
    configure();
    for (const body of ["Hello {{text}} {{1}}", "Hello {{Text}}", "Hello {{3}}", "Hello {{text1}}", "Hello {{text"] ) {
      const calls = graphFixture({
        templateOverride: { ...template(), components: [{ type: "BODY", text: body }] },
      });
      await assert.rejects(
        () => templates.sendApprovedMarketingTemplate({
          recipientE164: "+14165550124",
          templateName: "autumn_offer",
          languageCode: "en_US",
          bodyParameters: ["Alex"],
        }),
        (error) => error instanceof client.MetaApiError && error.definitiveRejection === true,
      );
      assert.equal(calls.filter((call) => call.options.method === "POST").length, 0);
    }
  } finally {
    restore();
  }
});

test("campaign send blocks a same-ID body or static button edit before POST", async () => {
  try {
    configure();
    const original = {
      ...template(),
      components: [
        { type: "HEADER", format: "TEXT", text: "Weekend offer" },
        { type: "BODY", text: "Hello {{1}}" },
        { type: "FOOTER", text: "The Oven Fresh" },
        { type: "BUTTONS", buttons: [{ type: "URL", text: "Order", url: "https://example.com/order" }] },
      ],
    };
    graphFixture({ templateOverride: original });
    const expectedTemplateSnapshot = (await templates.syncMetaTemplates()).templates[0];
    for (const changedComponents of [
      original.components.map((part) => part.type === "BODY" ? { ...part, text: "Different {{1}}" } : part),
      original.components.map((part) => part.type === "BUTTONS"
        ? { ...part, buttons: [{ type: "URL", text: "Order", url: "https://example.com/other" }] }
        : part),
    ]) {
      const calls = graphFixture({ templateOverride: { ...original, components: changedComponents } });
      await assert.rejects(
        () => templates.sendApprovedMarketingTemplate({
          recipientE164: "+14165550124",
          templateName: "autumn_offer",
          languageCode: "en_US",
          expectedTemplateId: "333333",
          expectedTemplateSnapshot,
          bodyParameters: ["Alex"],
        }),
        (error) => error instanceof client.MetaApiError &&
          error.definitiveRejection === true &&
          error.message.includes("content changed"),
      );
      assert.equal(calls.filter((call) => call.options.method === "POST").length, 0);
    }
  } finally {
    restore();
  }
});

test("a button type outside the reviewed static set cannot be sent", async () => {
  try {
    configure();
    const calls = graphFixture({
      templateOverride: {
        ...template(),
        components: [
          { type: "BODY", text: "Hello {{1}}" },
          { type: "BUTTONS", buttons: [{ type: "FLOW", text: "Open", flow_id: "flow-1" }] },
        ],
      },
    });
    await assert.rejects(
      () => templates.sendApprovedMarketingTemplate({
        recipientE164: "+14165550124",
        templateName: "autumn_offer",
        languageCode: "en_US",
        bodyParameters: ["Alex"],
      }),
      (error) => error instanceof client.MetaApiError &&
        error.definitiveRejection === true &&
        error.message.includes("button type"),
    );
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 0);
  } finally {
    restore();
  }
});

test("transport failure during POST remains uncertain", async () => {
  try {
    configure();
    graphFixture({ sendError: new Error("socket closed") });
    await assert.rejects(
      () => templates.sendApprovedTemplateTest({
        recipientE164: "+14165550124",
        templateName: "autumn_offer",
        languageCode: "en_US",
        bodyParameters: ["Alex"],
      }),
      (error) => error instanceof client.MetaApiError &&
        error.category === "transport" &&
        error.definitiveRejection === false &&
        !error.message.includes("socket closed"),
    );
  } finally {
    restore();
  }
});

test("final eligibility callback failure prevents POST", async () => {
  try {
    configure();
    const calls = graphFixture();
    let checkRan = false;
    await assert.rejects(
      () => templates.sendApprovedTemplateTest({
        recipientE164: "+14165550124",
        templateName: "autumn_offer",
        languageCode: "en_US",
        bodyParameters: ["Alex"],
        beforeSend: async () => {
          checkRan = true;
          throw new Error("sender is on hold");
        },
      }),
      (error) => error instanceof client.MetaApiError &&
        error.definitiveRejection === true &&
        !error.message.includes("sender is on hold"),
    );
    assert.equal(checkRan, true);
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 0);
  } finally {
    restore();
  }
});

test("explicit Graph rejection is definitive and exposes only numeric provider codes", async () => {
  try {
    configure();
    graphFixture({
      sendResponse: json({ error: { code: 131009, message: "private provider detail" } }, 400),
    });
    await assert.rejects(
      () => templates.sendApprovedTemplateTest({
        recipientE164: "+14165550124",
        templateName: "autumn_offer",
        languageCode: "en_US",
        bodyParameters: ["Alex"],
      }),
      (error) => error instanceof client.MetaApiError &&
        error.category === "provider" &&
        error.definitiveRejection === true &&
        error.providerCode === 131009 &&
        !error.message.includes("private provider detail"),
    );
  } finally {
    restore();
  }
});

test("ambiguous non-2xx send responses remain uncertain and expose no raw provider detail", async () => {
  try {
    configure();
    for (const status of [408, 429, 500, 503]) {
      graphFixture({
        sendResponse: json({ error: { code: 130429, message: "private provider detail" } }, status),
      });
      await assert.rejects(
        () => templates.sendApprovedTemplateTest({
          recipientE164: "+14165550124",
          templateName: "autumn_offer",
          languageCode: "en_US",
          bodyParameters: ["Alex"],
        }),
        (error) => error instanceof client.MetaApiError &&
          error.category === "provider" &&
          error.httpStatus === status &&
          error.definitiveRejection === false &&
          error.providerCode === 130429 &&
          !error.message.includes("private provider detail"),
      );
    }
  } finally {
    restore();
  }
});

test("templates with IMAGE header require a valid https URL and include header parameters", async () => {
  try {
    configure();
    const imageTemplate = {
      ...template(),
      components: [
        { type: "HEADER", format: "IMAGE" },
        { type: "BODY", text: "Special offer {{1}}" },
      ],
    };
    graphFixture({ templateOverride: imageTemplate });

    // Missing headerMediaUrl should reject
    await assert.rejects(
      () => templates.sendApprovedTemplateTest({
        recipientE164: "+14165550124",
        templateName: "autumn_offer",
        languageCode: "en_US",
        bodyParameters: ["Pizza"],
      }),
      (error) => error instanceof client.MetaApiError && error.definitiveRejection === true &&
        error.message.includes("image header URL is required"),
    );

    // Non-HTTPS headerMediaUrl should reject
    await assert.rejects(
      () => templates.sendApprovedTemplateTest({
        recipientE164: "+14165550124",
        templateName: "autumn_offer",
        languageCode: "en_US",
        bodyParameters: ["Pizza"],
        headerMediaUrl: "http://insecure.com/pic.jpg",
      }),
      (error) => error instanceof client.MetaApiError && error.definitiveRejection === true,
    );

    // Valid HTTPS headerMediaUrl succeeds and constructs header component
    const calls = graphFixture({ templateOverride: imageTemplate });
    const result = await templates.sendApprovedTemplateTest({
      recipientE164: "+14165550124",
      templateName: "autumn_offer",
      languageCode: "en_US",
      bodyParameters: ["Pizza"],
      headerMediaUrl: "https://example.com/promo.jpg",
    });
    assert.equal(result.messageId, "wamid.test-123");
    const postCall = calls.find((call) => call.options.method === "POST");
    assert.ok(postCall);
    const parsedPayload = JSON.parse(postCall.options.body);
    assert.deepEqual(parsedPayload.template.components, [
      {
        type: "header",
        parameters: [
          {
            type: "image",
            image: { link: "https://example.com/promo.jpg" },
          },
        ],
      },
      {
        type: "body",
        parameters: [
          { type: "text", text: "Pizza" },
        ],
      },
    ]);
  } finally {
    restore();
  }
});


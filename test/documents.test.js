const { describe, test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

/*
 * Documents (DOC-09–15): rendering with pre-filled fields and visible gaps,
 * why a tile is off, the template check a firm's edit must pass, and the
 * gates on every route. Install, versions and drafts run against a real
 * database in the integration suite.
 */

process.env.JWT_SECRET = "unit-test-secret";
process.env.JWT_ISSUER = "unit-test-issuer";
process.env.BUNDLE_SERVICE_URL = "http://bundle-service.test";

let installed;
const realFetch = global.fetch;

global.fetch = async (url, options) =>
  String(url).startsWith("http://bundle-service.test")
    ? new Response(JSON.stringify({ bundle: installed }), { status: 200 })
    : realFetch(url, options);

const pool = require("../src/config/database");

pool.query = async (text) => {
  if (/access_grants/.test(text)) return { rows: [] };
  if (/FROM document_templates/.test(text)) return { rows: [] };
  return { rows: [] };
};

const { render, reasonFor, missingIn } = require("../src/services/documentService");
const { checkBody, content } = require("../src/services/templateService");
const { forget } = require("../src/services/bundleContext");

const TEMPLATE = {
  body: "<p>{{client.name}}</p><p>Fee: {{money fields.fee}}</p><p>Ref: {{fields.reference}}</p><p>AY {{fields.assessment_year}}</p>",
  field_schema: {
    type: "object",
    properties: {
      fee: { type: "number", title: "Audit fee" },
      reference: { type: "string", title: "Reference number" },
      assessment_year: { type: "string", title: "Assessment year" },
    },
  },
  ui: { fee: { "ui:prefill": "engagement.fee_total" } },
};

const CONTEXT = { client: { name: "Acme <Pvt> Ltd" }, engagement: { fee_total: 45000 }, firm: { currency: "INR" } };

describe("rendering", () => {
  test("pre-fills fields from the engagement and escapes client data (DOC-11, FIX-03)", () => {
    const { html, fields } = render(TEMPLATE, CONTEXT, { reference: "SA/2026/14" });

    assert.equal(fields.fee, 45000);
    assert.match(html, /Acme &lt;Pvt&gt; Ltd/);
    assert.match(html, /₹45,000/);
    assert.match(html, /SA\/2026\/14/);
  });

  test("a typed value wins over the pre-fill", () => {
    assert.equal(render(TEMPLATE, CONTEXT, { fee: 50000 }).fields.fee, 50000);
  });

  test("a missing value shows its field's title, and is listed (DOC-12)", () => {
    const { html, missing } = render(TEMPLATE, CONTEXT, {});

    assert.match(html, /\[Reference number\]/);
    assert.deepEqual(missing.sort(), ["Assessment year", "Reference number"]);
  });

  test("missingIn reads the placeholders a render left", () => {
    assert.deepEqual(missingIn('<p><mark class="doc-placeholder">[PAN]</mark></p>'), ["PAN"]);
  });
});

describe("why a tile is off (DOC-09)", () => {
  test("names the service to engage, or the field to fill", () => {
    assert.equal(reasonFor({ engaged: "tax_audit" }, { tax_audit: "Tax Audit" }), "Needs Tax Audit engaged for this year");
    assert.equal(reasonFor({ filled: { var: "engagement.attributes.previous_auditor.firm" } }, {}), "Needs previous auditor firm filled in");
    assert.equal(reasonFor({ and: [] }, {}), "Not applicable for this year");
  });
});

describe("field order", () => {
  test("is recorded at install, since JSONB does not keep key order", () => {
    const shipped = content({ name: "x", body: "<p></p>", fields: { type: "object", properties: { reference: {}, letter_date: {}, firm_type: {} } }, ui: { reference: { "ui:widget": "text" } } });

    assert.deepEqual(shipped.ui["ui:order"], ["reference", "letter_date", "firm_type", "*"]);
    assert.deepEqual(shipped.ui.reference, { "ui:widget": "text" });
  });

  test("a bundle's own order is kept, and a stored row hashes the same", () => {
    const shipped = content({ name: "x", body: "<p></p>", fields: { type: "object", properties: { a: {}, b: {} } }, ui: { "ui:order": ["b", "a"] } });

    assert.deepEqual(shipped.ui["ui:order"], ["b", "a"]);
    assert.deepEqual(content({ ...shipped, field_schema: shipped.fields, enabled_when: null }).ui, shipped.ui);
  });
});

describe("a firm's template text", () => {
  test("is held to the bundle's rules", () => {
    assert.doesNotThrow(() => checkBody("<p>{{client.name}} {{fields.reference}}</p>", TEMPLATE.field_schema));

    for (const body of ["<script>x</script>", "{{{client.name}}}", "{{fields.unknown}}", "{{lookup client 'name'}}"]) {
      assert.throws(() => checkBody(body, TEMPLATE.field_schema), (error) => error.statusCode === 400 && Boolean(error.details.body), body);
    }
  });
});

const app = require("../src/app");
let server;
let base;

before(async () => {
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  global.fetch = realFetch;
});

beforeEach(() => {
  installed = { key: "ca-practice", capabilities: ["documents"] };
  forget(3);
});

const call = (method, path, permissions, body) =>
  realFetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt.sign({ sub: 7, organizationId: 3, role: "X", permissions }, process.env.JWT_SECRET, { issuer: process.env.JWT_ISSUER })}`,
    },
    body: body && JSON.stringify(body),
  });

describe("routes", () => {
  test("reading needs documents.read, and a bundle", async () => {
    assert.equal((await call("GET", "/documents/templates", [])).status, 403);

    installed = null;
    forget(3);
    assert.equal((await call("GET", "/documents/templates", ["documents.read"])).status, 404);
  });

  test("generating needs documents.generate; editing a template needs settings", async () => {
    assert.equal((await call("POST", "/documents", ["documents.read"], { templateKey: "consent_letter", customerId: 5 })).status, 403);
    assert.equal((await call("PUT", "/documents/templates/consent_letter", ["documents.generate"], { body: "x" })).status, 403);
    assert.equal((await call("POST", "/documents/templates/consent_letter/restore", ["documents.generate"])).status, 403);
  });

  test("previewing unsaved template text needs settings too", async () => {
    const response = await call("POST", "/documents/preview", ["documents.read"], { templateKey: "consent_letter", body: "<p>x</p>" });
    assert.equal(response.status, 403);
  });

  test("the install step needs bundles.manage and a list", async () => {
    assert.equal((await call("PUT", "/documents/bundles/ca-practice/0.5.0", ["documents.read"], { documents: [] })).status, 403);
    assert.equal((await call("PUT", "/documents/bundles/ca-practice/0.5.0", ["bundles.manage"], { documents: "x" })).status, 400);
  });

  test("bad ids and keys are refused before any work", async () => {
    assert.equal((await call("GET", "/documents/abc", ["documents.read"])).status, 400);
    assert.equal((await call("GET", "/documents/templates/Bad-Key", ["documents.read"])).status, 400);
    assert.equal((await call("GET", "/documents/templates?period=26-27", ["documents.read"])).status, 400);
  });
});

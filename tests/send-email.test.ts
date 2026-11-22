/**
 * The SES sender's contract: no attempt at all without both SES keys, a signed
 * request to the configured region when they are set, and every failure turned
 * into `false` plus one redacted log line — never a throw, so an email cannot
 * fail the action that sent it. The keys below are placeholders.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { sendTransactional } from "../src/libs/ses/send-email.ts";

const SECRET = "ses-secret-placeholder-0000000000";
const CONFIGURED = { SES_ACCESS_KEY_ID: "AKIAPLACEHOLDER00000", SES_SECRET_ACCESS_KEY: SECRET };
const EMAIL = { subject: "Subject", html: "<p>Hi</p>", text: "Hi" };

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { impl, calls };
}

const send = (env: Record<string, string | undefined>, fetchImpl: typeof fetch, render = async () => EMAIL) =>
  sendTransactional({ to: "invitee@example.test", label: "invite", render }, { env, fetch: fetchImpl });

let warn: ReturnType<typeof mock.method>;
beforeEach(() => {
  warn = mock.method(console, "warn", () => {});
});
afterEach(() => {
  mock.restoreAll();
});

const loggedLines = () => warn.mock.calls.map((c) => String(c.arguments[0]));

describe("sendTransactional", () => {
  it("makes no attempt and renders nothing when SES is not configured", async () => {
    for (const env of [{}, { SES_ACCESS_KEY_ID: "AKIAPLACEHOLDER00000" }, { ...CONFIGURED, SES_SECRET_ACCESS_KEY: " " }]) {
      const { impl, calls } = fakeFetch(() => new Response("{}"));
      let rendered = false;
      const sent = await send(env, impl, async () => {
        rendered = true;
        return EMAIL;
      });
      assert.equal(sent, false);
      assert.equal(calls.length, 0);
      assert.equal(rendered, false);
    }
    assert.equal(warn.mock.callCount(), 0, "not configured is a deliberate state, not a warning");
  });

  it("sends a signed SES v2 request from the default Terragram sender in eu-west-2", async () => {
    const { impl, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
    assert.equal(await send(CONFIGURED, impl), true);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call?.url, "https://email.eu-west-2.amazonaws.com/v2/email/outbound-emails");
    const headers = call?.init.headers as Record<string, string>;
    assert.match(headers.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=AKIAPLACEHOLDER00000\/\d{8}\/eu-west-2\/ses\//);
    const body = JSON.parse(String(call?.init.body));
    assert.equal(body.FromEmailAddress, "Terragram <invites@terragram.dev>");
    assert.deepEqual(body.Destination, { ToAddresses: ["invitee@example.test"] });
    assert.equal(body.Content.Simple.Subject.Data, "Subject");
    assert.equal(body.Content.Simple.Body.Html.Data, "<p>Hi</p>");
    assert.equal(body.Content.Simple.Body.Text.Data, "Hi");
  });

  it("honours EMAIL_FROM and SES_REGION", async () => {
    const { impl, calls } = fakeFetch(() => new Response("{}"));
    await send({ ...CONFIGURED, EMAIL_FROM: "Ops <ops@example.test>", SES_REGION: "eu-west-1" }, impl);
    assert.equal(calls[0]?.url, "https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    assert.equal(JSON.parse(String(calls[0]?.init.body)).FromEmailAddress, "Ops <ops@example.test>");
  });

  it("returns false and logs one redacted line when SES refuses", async () => {
    const { impl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            message: `Email address is not verified. The following identities failed the check in region EU-WEST-2: invitee@example.test (key ${SECRET})`,
          }),
          { status: 400, headers: { "x-amzn-errortype": "MessageRejected" } },
        ),
    );
    assert.equal(await send(CONFIGURED, impl), false);
    const lines = loggedLines();
    assert.equal(lines.length, 1);
    const [line] = lines;
    assert.match(line ?? "", /email send failed/);
    assert.match(line ?? "", /SES 400 MessageRejected/);
    assert.doesNotMatch(line ?? "", /invitee@example\.test/, "the recipient's address is not logged");
    assert.equal(line?.includes(SECRET), false);
  });

  it("returns false, never throws, when the network or the template fails", async () => {
    const down = fakeFetch(() => {
      throw new Error("connect ECONNREFUSED");
    });
    assert.equal(await send(CONFIGURED, down.impl), false);

    const ok = fakeFetch(() => new Response("{}"));
    const broken = await send(CONFIGURED, ok.impl, async () => {
      throw new Error("template exploded");
    });
    assert.equal(broken, false);
    assert.equal(ok.calls.length, 0);
    assert.equal(loggedLines().length, 2);
  });
});

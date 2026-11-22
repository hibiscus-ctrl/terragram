// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hand-rolled SigV4 signer against AWS's published worked example. If this
 * passes, the signing math matches AWS byte for byte.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { amzDate, deriveSigningKey, sigv4AuthHeaders } from "../src/libs/ses/sigv4.ts";

// AWS reference example (us-east-1 / iam, GET ListUsers with query params).
// https://docs.aws.amazon.com/general/latest/gr/sigv4-signed-request-examples.html
// The key below is AWS's documented example credential, not an issued one.
const EXAMPLE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "iam",
  amzDate: "20150830T123600Z",
  host: "iam.amazonaws.com",
  method: "GET",
  query: "Action=ListUsers&Version=2010-05-08",
  body: "",
  contentType: "application/x-www-form-urlencoded; charset=utf-8",
  expectedSigningKeyHex: "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
  expectedSignature: "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
};

describe("SigV4 signer (AWS reference example)", () => {
  it("derives the documented signing key", () => {
    const key = deriveSigningKey(
      EXAMPLE.secretAccessKey,
      EXAMPLE.amzDate.slice(0, 8),
      EXAMPLE.region,
      EXAMPLE.service,
    );
    assert.equal(key.toString("hex"), EXAMPLE.expectedSigningKeyHex);
  });

  it("produces the documented Authorization signature", () => {
    const headers = sigv4AuthHeaders({
      method: EXAMPLE.method,
      host: EXAMPLE.host,
      path: "/",
      query: EXAMPLE.query,
      body: EXAMPLE.body,
      region: EXAMPLE.region,
      service: EXAMPLE.service,
      accessKeyId: EXAMPLE.accessKeyId,
      secretAccessKey: EXAMPLE.secretAccessKey,
      amzDate: EXAMPLE.amzDate,
      contentType: EXAMPLE.contentType,
    });
    assert.match(headers.authorization ?? "", new RegExp(`Signature=${EXAMPLE.expectedSignature}$`));
    assert.equal(headers["x-amz-date"], EXAMPLE.amzDate);
    assert.ok(headers.authorization?.startsWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/"));
  });
});

describe("amzDate", () => {
  it("formats a Date as the SigV4 basic timestamp", () => {
    assert.equal(amzDate(new Date("2015-08-30T12:36:00.000Z")), "20150830T123600Z");
  });
});

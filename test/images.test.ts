import { test } from "node:test";
import assert from "node:assert/strict";
import { readImage, imageMime, MAX_IMAGE_BYTES } from "../src/images.ts";
import { Inbox } from "../src/core.ts";

const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
test("image signatures and base64 conversion", async () => {
  assert.equal(imageMime(png), "image/png");
  assert.equal(imageMime(Buffer.from('<svg>unsafe</svg>')), undefined);
  const image = await readImage(new Response(png));
  assert.deepEqual(image, { type: "image", mimeType: "image/png", data: png.toString("base64") });
});
test("image size is bounded by both headers and actual streamed bytes", async () => {
  await assert.rejects(readImage(new Response(png, { headers: { "content-length": String(MAX_IMAGE_BYTES + 1) } })));
  await assert.rejects(readImage(new Response(new Uint8Array(MAX_IMAGE_BYTES + 1))));
  await assert.rejects(readImage(new Response("not an image")));
});
test("image queue limits memory and stop discards image content", () => {
  const inbox = new Inbox();
  for (let i = 0; i < 5; i++) assert.equal(inbox.enqueueImage([{ type: "image", mimeType: "image/png", data: "test" }]), true);
  assert.equal(inbox.enqueueImage([]), false);
  assert.equal(inbox.stop(), 5);
  inbox.settled();
  assert.equal(inbox.takeTask(), undefined);
});

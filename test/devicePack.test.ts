import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { devicePack, packCompatible, assertPackCompatible, SUPPORTED_PACK_API } from "../src/database/pack";
import { devices } from "../src/database/loader";
import { boards } from "../src/database/boardLoader";
import { getPeripherals } from "../src/core/resolver/peripherals";

const packRoot = join(process.cwd(), "packages", "esp-device-pack");
const SEMVER = /^\d+\.\d+\.\d+$/;

test("device pack manifest is well-formed and versioned independently of the extension", () => {
  assert.equal(devicePack.id, "esp-device-pack");
  assert.match(devicePack.version, SEMVER);
  assert.match(devicePack.databaseVersion, SEMVER);
  assert.ok(Number.isInteger(devicePack.apiVersion));
  assert.ok(devicePack.devices.length > 0);
  assert.ok(devicePack.boards.length > 0);
});

test("the extension only loads packs whose manifest apiVersion it understands", () => {
  assert.deepEqual([...SUPPORTED_PACK_API], [1]);
  assert.equal(packCompatible(1), true);
  assert.equal(packCompatible(2), false);
  assert.doesNotThrow(() => assertPackCompatible(devicePack));
  assert.throws(() => assertPackCompatible({ ...devicePack, apiVersion: 99 }), /apiVersion 99/);
});

test("the manifest agrees with the data the extension actually loads", () => {
  assert.deepEqual(devicePack.devices.map(entry => entry.chip).sort(), devices.map(d => d.id).sort());
  for (const entry of devicePack.devices) {
    assert.ok(getPeripherals(entry.chip).length > 0, `${entry.chip} must expose peripherals`);
  }
  const manifestBoards = devicePack.boards.map(entry => `${entry.vendor}/${entry.id}`).sort();
  assert.deepEqual(manifestBoards, boards.map(b => `${b.vendor}/${b.id}`).sort());
});

test("every file referenced by the manifest ships inside the pack", () => {
  for (const entry of [...devicePack.devices.flatMap(d => [d.device, d.peripherals]), ...devicePack.boards.map(b => b.path)]) {
    assert.ok(existsSync(join(packRoot, entry)), `missing pack file: ${entry}`);
  }
});

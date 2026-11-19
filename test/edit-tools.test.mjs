import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEditTools } from '../server/edit-tools.mjs';

function harness() {
  const calls = [];
  const runLuau = async (name, args, timeout) => {
    calls.push({ name, args, timeout });
    return { ok: true };
  };
  const tools = Object.fromEntries(createEditTools({ runLuau }).map((tool) => [tool.name, tool]));
  return { calls, tools };
}

test('set_keyframes forwards a valid batch unchanged with a long timeout', async () => {
  const { calls, tools } = harness();
  const keyframes = [
    { item: 'Idol', joint: 'Head', frame: 0, rotation: [10, 0, 0], ease: { type: 'Sine' } },
    { item: 'camera', property: 'FieldOfView', frame: 30, value: 40 },
    { item: 2, property: 'LookAtPart', frame: 60, value: null },
  ];
  await tools.moon_set_keyframes.call({ keyframes });
  assert.deepEqual(calls, [{ name: 'set_keyframes', args: { keyframes }, timeout: 120 }]);
});

test('edit tools reject malformed arguments before reaching Studio', async () => {
  const { calls, tools } = harness();
  const invalid = [
    ['moon_set_keyframes', { keyframes: [] }],
    ['moon_set_keyframes', { keyframes: [{ item: 'Idol', frame: 0 }] }],
    ['moon_set_keyframes', { keyframes: [{ item: 'Idol', joint: 'Head', property: 'CFrame', frame: 0 }] }],
    ['moon_set_keyframes', { keyframes: [{ item: 'Idol', joint: 'Head', frame: -1 }] }],
    ['moon_set_keyframes', { keyframes: [{ item: 'Idol', joint: 'Head', frame: 1.5 }] }],
    ['moon_set_keyframes', { keyframes: [{ item: 'Idol', joint: 'Head', frame: 0, value: 3 }] }],
    ['moon_set_keyframes', { keyframes: [{ item: 'camera', property: 'FieldOfView', frame: 0 }] }],
    ['moon_set_keyframes', { keyframes: [{ item: {}, joint: 'Head', frame: 0 }] }],
    ['moon_delete_keyframes', { targets: [{ item: 'Idol' }] }],
    ['moon_delete_keyframes', { targets: [{ item: 'Idol', joint: 'Head', frames: [] }] }],
    ['moon_add_items', { items: [{}] }],
    ['moon_add_items', { items: [] }],
    ['moon_open_file', { name: '' }],
    ['moon_open_file', { name: 'a-name-longer-than-twenty-chars' }],
    ['moon_settings', { length: 10 }],
    ['moon_undo', { steps: 0 }],
    ['moon_insert_rig', {}],
    ['moon_attach_prop', { rig: 'Workspace.R', attach_to: 'RightHand', name: 'Mic', parts: [] }],
  ];
  for (const [name, args] of invalid) {
    await assert.rejects(async () => tools[name].call(args), undefined, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(calls.length, 0);
});

test('file tools map to the right operations and defaults', async () => {
  const { calls, tools } = harness();
  await tools.moon_save.call({});
  await tools.moon_undo.call({});
  await tools.moon_undo.call({ steps: 3, redo: true });
  await tools.moon_settings.call({ length: 420, loop: true });
  await tools.moon_open_file.call({ name: 'Dance', create: true });
  await tools.moon_insert_rig.call({ name: 'Idol' });
  assert.deepEqual(calls.map((call) => [call.name, call.args]), [
    ['file_ops', { op: 'save' }],
    ['file_ops', { op: 'undo', steps: 1 }],
    ['file_ops', { op: 'redo', steps: 3 }],
    ['file_ops', { op: 'settings', length: 420, loop: true, priority: undefined }],
    ['open_file', { name: 'Dance', create: true, discardChanges: false }],
    ['insert_rig', { kind: 'R15', name: 'Idol', position: [0, 0, 0], facing: 0 }],
  ]);
});

test('spin validates its range and forwards the motion options', async () => {
  const { calls, tools } = harness();
  await tools.moon_spin.call({
    item: 'Idol',
    joint: 'LowerTorso',
    from_frame: 218,
    to_frame: 260,
    axis: 'x',
    degrees: 360,
    easing: 'in_out',
    position_to: [0, 0, 1.5],
    arc_height: 3,
  });
  assert.deepEqual(calls[0], {
    name: 'spin',
    args: {
      item: 'Idol',
      joint: 'LowerTorso',
      fromFrame: 218,
      toFrame: 260,
      axis: 'x',
      degrees: 360,
      space: undefined,
      easing: 'in_out',
      startRotation: undefined,
      positionFrom: undefined,
      positionTo: [0, 0, 1.5],
      arcHeight: 3,
    },
    timeout: undefined,
  });

  const base = { item: 'Idol', joint: 'Head', from_frame: 0, to_frame: 30, axis: 'y', degrees: 360 };
  for (const bad of [{ to_frame: 0 }, { axis: 'w' }, { degrees: 0 }, { degrees: Number.NaN }, { joint: undefined }, { from_frame: -1 }]) {
    await assert.rejects(async () => tools.moon_spin.call({ ...base, ...bad }), undefined, JSON.stringify(bad));
  }
  assert.equal(calls.length, 1);
});

test('attach_prop takes either an existing instance or primitive parts', async () => {
  const { calls, tools } = harness();
  const base = { rig: 'Workspace.Idol', attach_to: 'LeftHand', name: 'Lightstick' };
  await tools.moon_attach_prop.call({ ...base, source: 'Workspace.Lightstick', handle: 'Handle' });
  await tools.moon_attach_prop.call({ ...base, parts: [{ size: [1, 1, 1] }] });
  assert.equal(calls[0].args.source, 'Workspace.Lightstick');
  assert.equal(calls[0].args.handle, 'Handle');
  assert.equal(calls[0].args.parts, undefined);
  assert.equal(calls[1].args.source, undefined);

  for (const bad of [{}, { source: 'Workspace.A', parts: [{ size: [1, 1, 1] }] }, { parts: [{ size: [1, 1, 1] }], handle: 'Handle' }, { source: '' }]) {
    await assert.rejects(async () => tools.moon_attach_prop.call({ ...base, ...bad }), undefined, JSON.stringify(bad));
  }
  assert.equal(calls.length, 2);
});

test('export only overwrites when asked', async () => {
  const { calls, tools } = harness();
  await tools.moon_export.call({});
  await tools.moon_export.call({ overwrite: true });
  assert.deepEqual(calls.map((call) => call.args), [{ overwrite: false }, { overwrite: true }]);
});

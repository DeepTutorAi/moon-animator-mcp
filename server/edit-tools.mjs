// MCP tools that change Moon Animator files or the Studio scene. Structural
// argument checks happen here; everything that depends on the live file (item,
// joint and property names, value types, frame limits) is validated in the
// Luau snippets before anything is modified.

const VECTOR3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };

const EASE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  description:
    'Easing from this keyframe toward the next one. Omitted: Linear for a new keyframe, unchanged for an existing one.',
  properties: {
    type: {
      type: 'string',
      enum: ['Linear', 'Constant', 'Sine', 'Quad', 'Cubic', 'Quart', 'Quint', 'Sextic', 'Expo', 'Circ', 'Back', 'Elastic', 'Bounce'],
    },
    direction: { type: 'string', enum: ['In', 'Out', 'InOut', 'OutIn'], default: 'InOut' },
    overshoot: { type: 'number', description: 'Back only.' },
    amplitude: { type: 'number', description: 'Elastic only.' },
    period: { type: 'number', description: 'Elastic only.' },
  },
};

const ITEM_REF = {
  type: ['string', 'integer'],
  description: 'Item in the open file: its instance name, full path, 1-based index, or "camera".',
};

function text(value) {
  return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
}

function list(value, name, max) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new Error(`${name} must be a list of 1 to ${max} entries`);
  }
  return value;
}

function target(entry, label) {
  if (typeof entry !== 'object' || entry === null) throw new Error(`${label} must be an object`);
  if (typeof entry.item !== 'string' && !Number.isInteger(entry.item)) {
    throw new Error(`${label}.item must be an item name, path or index`);
  }
  if ((entry.joint === undefined) === (entry.property === undefined)) {
    throw new Error(`${label} needs exactly one of joint or property`);
  }
}

function frame(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer frame`);
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`);
  return value;
}

export function createEditTools({ runLuau }) {
  const run = async (name, args, timeout) => [text(await runLuau(name, args, timeout))];

  return [
    {
      name: 'moon_open_file',
      description:
        'Opens a Moon Animator file by name (files live in ServerStorage.MoonAnimator2Saves), closing the current ' +
        'one. With create=true a missing file is created and saved. Refuses to drop unsaved changes unless ' +
        'discard_changes=true. Opening a file clears Moon Animator undo history, as it does in the UI.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 20 },
          create: { type: 'boolean', default: false },
          discard_changes: { type: 'boolean', default: false },
        },
      },
      call: (args) => {
        const name = nonEmptyString(args.name, 'name');
        if (name.length > 20) throw new Error('name must be at most 20 characters (Moon Animator limit)');
        return run('open_file', { name, create: args.create === true, discardChanges: args.discard_changes === true });
      },
    },
    {
      name: 'moon_save',
      description: 'Saves the open Moon Animator file. Like saving in the UI, this resets Studio undo history.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      call: () => run('file_ops', { op: 'save' }),
    },
    {
      name: 'moon_settings',
      description:
        'Changes settings of the open file: timeline length in frames, loop, and export priority. With no ' +
        'arguments it just reports the current settings and whether there are unsaved changes.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          length: { type: 'integer', minimum: 60, description: 'Timeline length in frames.' },
          loop: { type: 'boolean' },
          priority: { type: 'string', description: 'Enum.AnimationPriority name, e.g. Action.' },
        },
      },
      call: (args) => {
        if (args.length !== undefined && (!Number.isInteger(args.length) || args.length < 60)) {
          throw new Error('length must be an integer of at least 60 frames');
        }
        return run('file_ops', { op: 'settings', length: args.length, loop: args.loop, priority: args.priority });
      },
    },
    {
      name: 'moon_undo',
      description:
        'Undoes (or with redo=true, redoes) Moon Animator actions in the open file, the same history Ctrl+Z uses. ' +
        'Each moon_set_keyframes, moon_delete_keyframes and item addition is one step.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          steps: { type: 'integer', minimum: 1, maximum: 30, default: 1 },
          redo: { type: 'boolean', default: false },
        },
      },
      call: (args) => {
        const steps = args.steps ?? 1;
        if (!Number.isInteger(steps) || steps < 1 || steps > 30) throw new Error('steps must be an integer from 1 to 30');
        return run('file_ops', { op: args.redo === true ? 'redo' : 'undo', steps });
      },
    },
    {
      name: 'moon_insert_rig',
      description:
        "Places one of Moon Animator's built-in character rigs (R15, R6, OldR15, or the Template variants) in the " +
        'Workspace. position is where the feet go; facing turns it around the vertical axis in degrees (0 faces -Z).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          kind: { type: 'string', default: 'R15' },
          name: { type: 'string', minLength: 1 },
          position: { ...VECTOR3, default: [0, 0, 0] },
          facing: { type: 'number', default: 0 },
        },
      },
      call: (args) =>
        run('insert_rig', {
          kind: args.kind ?? 'R15',
          name: nonEmptyString(args.name, 'name'),
          position: args.position ?? [0, 0, 0],
          facing: args.facing ?? 0,
        }),
    },
    {
      name: 'moon_attach_prop',
      description:
        'Joins a prop to a part of a rig with a Motor6D, so it becomes an animatable joint of that rig (like Moon ' +
        "Animator's Easy Weld). Give `source` to copy an existing Model, part, Tool or Accessory (the original " +
        'is left alone; scripts inside the copy are removed), or `parts` to build one from primitives (the first ' +
        'part is the handle, later parts are placed relative to it). grip places the handle relative to the rig ' +
        'part. If the rig is already in the open file, the file must be saved; it is then reloaded so the new ' +
        'joint gets a track (keyframes are kept, Moon Animator undo history is cleared).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['rig', 'attach_to', 'name'],
        properties: {
          rig: { type: 'string', description: 'Rig path, e.g. Workspace.Dancer.' },
          attach_to: { type: 'string', description: 'Rig part to hold the prop, e.g. RightHand.' },
          name: { type: 'string', minLength: 1, description: 'Joint and handle name; must be unique inside the rig.' },
          source: { type: 'string', description: 'Path of an existing instance to copy, e.g. Workspace.Guitar.' },
          handle: { type: 'string', description: 'With source: the part to grip (default: PrimaryPart, a part named Handle, or the first part).' },
          grip: {
            type: 'object',
            additionalProperties: false,
            properties: { position: VECTOR3, rotation: VECTOR3 },
          },
          parts: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['size'],
              properties: {
                shape: { type: 'string', enum: ['Block', 'Ball', 'Cylinder'], default: 'Block' },
                size: VECTOR3,
                offset: VECTOR3,
                rotation: VECTOR3,
                color: { ...VECTOR3, description: 'RGB 0-255.' },
                material: { type: 'string', description: 'Enum.Material name.' },
              },
            },
          },
        },
      },
      call: (args) => {
        if ((args.source === undefined) === (args.parts === undefined)) {
          throw new Error('give exactly one of source (an existing instance) or parts (primitives)');
        }
        if (args.parts !== undefined) list(args.parts, 'parts', 12);
        if (args.source !== undefined) nonEmptyString(args.source, 'source');
        if (args.handle !== undefined && args.source === undefined) throw new Error('handle only applies with source');
        return run('attach_prop', {
          rig: nonEmptyString(args.rig, 'rig'),
          attachTo: nonEmptyString(args.attach_to, 'attach_to'),
          name: nonEmptyString(args.name, 'name'),
          grip: args.grip,
          parts: args.parts,
          source: args.source,
          handle: args.handle,
        });
      },
    },
    {
      name: 'moon_add_items',
      description:
        'Adds instances to the open file as Moon Animator items. path is an instance path such as ' +
        'Workspace.Dancer, or one of the shortcuts camera, subtitles, letterbox, vignette, screen_cover. A rig ' +
        'gets its joint tracks; other items get their default properties unless properties is given. Returns the ' +
        'joint names of added rigs.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path'],
              properties: {
                path: { type: 'string' },
                properties: { type: 'array', items: { type: 'string' }, minItems: 1 },
                markers: { type: 'boolean', default: false, description: 'Also add an event marker track.' },
              },
            },
          },
        },
      },
      call: (args) => {
        list(args.items, 'items', 20).forEach((item, index) => nonEmptyString(item?.path, `items[${index}].path`));
        return run('add_items', { items: args.items });
      },
    },
    {
      name: 'moon_set_keyframes',
      description:
        'Adds or updates keyframes in the open file as ONE undo step. For a rig joint give `joint` (full hierarchy ' +
        'path or a unique ending such as "Head") with rotation (XYZ degrees) and/or position (studs), both relative ' +
        'to the rest pose in the joint frame: for a rig facing -Z, +X rotation swings a limb forward / leans the ' +
        'torso back, +Y turns left, +Z raises the right side. For a property give `property` and `value` ' +
        '(number, boolean, string, [x,y,z], [r,g,b], or for CFrame {position, rotation} or {position, look_at}). ' +
        'Rotations interpolate along the shortest path, so key a spin at least every 120 degrees. Easing applies ' +
        'from a keyframe toward the next one.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['keyframes'],
        properties: {
          keyframes: {
            type: 'array',
            minItems: 1,
            maxItems: 2000,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['item', 'frame'],
              properties: {
                item: ITEM_REF,
                joint: { type: 'string' },
                property: { type: 'string' },
                frame: { type: 'integer', minimum: 0 },
                rotation: VECTOR3,
                position: VECTOR3,
                value: {},
                ease: EASE_SCHEMA,
              },
            },
          },
        },
      },
      call: (args) => {
        list(args.keyframes, 'keyframes', 2000).forEach((keyframe, index) => {
          const label = `keyframes[${index}]`;
          target(keyframe, label);
          frame(keyframe.frame, `${label}.frame`);
          if (keyframe.property !== undefined && keyframe.value === undefined) {
            throw new Error(`${label} sets a property and needs a value`);
          }
          if (keyframe.joint !== undefined && keyframe.value !== undefined) {
            throw new Error(`${label} sets a joint; use rotation and position instead of value`);
          }
        });
        return run('set_keyframes', { keyframes: args.keyframes }, 120);
      },
    },
    {
      name: 'moon_spin',
      description:
        'Keys a rotation of ANY size on one rig joint between two frames as one undo step: a 360 backflip, a ' +
        'pirouette, a prop twirl. It adds evenly timed keyframes at most 90 degrees apart so the turn goes the ' +
        'intended way, replacing keyframes already between the two frames on that joint. Rotation starts from ' +
        'the pose at from_frame (or start_rotation). Optional position_from/position_to move the joint during ' +
        'the spin and arc_height adds a jump arc, so a whole flip of the root joint is one call.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'joint', 'from_frame', 'to_frame', 'axis', 'degrees'],
        properties: {
          item: ITEM_REF,
          joint: { type: 'string' },
          from_frame: { type: 'integer', minimum: 0 },
          to_frame: { type: 'integer', minimum: 1 },
          axis: { type: 'string', enum: ['x', 'y', 'z'] },
          degrees: { type: 'number', description: 'Signed total rotation, e.g. 360 or -720.' },
          space: {
            type: 'string',
            enum: ['parent', 'local'],
            default: 'parent',
            description: 'Turn about the axis of the joint frame (parent) or of the already rotated part (local).',
          },
          easing: { type: 'string', enum: ['linear', 'in', 'out', 'in_out'], default: 'linear' },
          start_rotation: VECTOR3,
          position_from: VECTOR3,
          position_to: VECTOR3,
          arc_height: { type: 'number', description: 'Extra height at the middle of the spin, in studs.' },
        },
      },
      call: (args) => {
        target({ item: args.item, joint: args.joint }, 'spin');
        frame(args.from_frame, 'from_frame');
        frame(args.to_frame, 'to_frame');
        if (args.to_frame <= args.from_frame) throw new Error('to_frame must be after from_frame');
        if (!['x', 'y', 'z'].includes(args.axis)) throw new Error('axis must be x, y or z');
        if (typeof args.degrees !== 'number' || !Number.isFinite(args.degrees) || args.degrees === 0) {
          throw new Error('degrees must be a non-zero number');
        }
        return run('spin', {
          item: args.item,
          joint: args.joint,
          fromFrame: args.from_frame,
          toFrame: args.to_frame,
          axis: args.axis,
          degrees: args.degrees,
          space: args.space,
          easing: args.easing,
          startRotation: args.start_rotation,
          positionFrom: args.position_from,
          positionTo: args.position_to,
          arcHeight: args.arc_height,
        });
      },
    },
    {
      name: 'moon_export',
      description:
        "Exports the open file with Moon Animator's own exporter: a KeyframeSequence for each rig under " +
        '<rig>.AnimSaves (ready to publish to Roblox as an animation) and a camera animation folder under the ' +
        'Camera. Each KeyframeSequence is then read back and every pose compared with the timeline; the result ' +
        'reports the worst difference. Refuses to replace an existing export of the same name unless overwrite=true.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { overwrite: { type: 'boolean', default: false } },
      },
      call: (args) => run('export', { overwrite: args.overwrite === true }, 120),
    },
    {
      name: 'moon_delete_keyframes',
      description:
        'Deletes keyframes in the open file as one undo step. Each target names an item and a joint or property; ' +
        'give frames to delete specific keyframes or omit it to clear the whole track.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['targets'],
        properties: {
          targets: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['item'],
              properties: {
                item: ITEM_REF,
                joint: { type: 'string' },
                property: { type: 'string' },
                frames: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1 },
              },
            },
          },
        },
      },
      call: (args) => {
        list(args.targets, 'targets', 500).forEach((entry, index) => {
          const label = `targets[${index}]`;
          target(entry, label);
          if (entry.frames !== undefined) {
            list(entry.frames, `${label}.frames`, 2000).forEach((value) => frame(value, `${label}.frames`));
          }
        });
        return run('delete_keyframes', { targets: args.targets });
      },
    },
  ];
}

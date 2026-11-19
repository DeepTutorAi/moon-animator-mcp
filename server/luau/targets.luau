-- Helpers for edit snippets: resolving items, tracks, instances, values and
-- easing from tool arguments. Requires prelude.luau before it.
local Ease = require(Moon.class.Ease)

local function fail(message)
	error("MOON: " .. message, 0)
end

local function requireEditable()
	requireFile()
	if Win.ChildModal then
		fail("a Moon Animator dialog is open; close it before editing")
	end
end

local function itemPath(itemObject)
	return table.concat(itemObject.Path.InstanceNames, ".")
end

-- Why an item's tracks no longer drive anything, or nil when they do. Tracks
-- keep the instances they were built for, so an instance that was deleted, or
-- replaced by another one of the same name, leaves them aimed at the old one.
local function staleReason(itemObject)
	local instance = itemObject.Path:GetItem()
	if not instance then
		return "missing"
	end
	if LS.LayerHandler.ItemMap[instance:GetDebugId(8)] ~= itemObject then
		return "replaced"
	end
	return nil
end

-- Moon Animator indexes items by the instance they were added for and asserts
-- on that index when an item is removed or the file is closed. After an
-- instance was replaced, the index still holds the old one and those
-- operations fail partway. This points the index at the instance the item's
-- path now resolves to. The item's tracks stay aimed at the old instance, so
-- call it only right before removing the item or closing the file.
local function rekeyItem(itemObject)
	local map = LS.LayerHandler.ItemMap
	local instance = itemObject.Path:GetItem()
	if not instance then
		return
	end
	local key = instance:GetDebugId(8)
	if map[key] ~= nil then
		return
	end
	for existing, owner in pairs(map) do
		if owner == itemObject then
			map[existing] = nil
		end
	end
	map[key] = itemObject
end

-- Closes the open file. Moon Animator would otherwise fail on a replaced instance.
local function closeFile()
	for _, container in ipairs(LS.LayerHandler.LayerContainer.Objects) do
		rekeyItem(container.ItemObject)
	end
	Win.CloseFile()
end

local function requireLinked(itemObject)
	local reason = staleReason(itemObject)
	if reason == "missing" then
		fail(itemPath(itemObject) .. " no longer exists in the place; put it back, or remove the item with moon_remove_items")
	elseif reason == "replaced" then
		fail(string.format(
			"%s was replaced by another instance of the same name after the file was opened, so its tracks still "
				.. "drive the old one; call moon_save, then moon_open_file with name '%s' to link them to the new instance",
			itemPath(itemObject),
			LS.CurrentFile.Name
		))
	end
	return itemObject
end

-- An item reference is its 1-based index, its full path, its instance name, or
-- "camera". Items whose instance is gone or was replaced are refused unless
-- `allowStale` is set.
local function findItem(ref, allowStale)
	local check = if allowStale then function(itemObject)
		return itemObject
	end else requireLinked
	local objects = LS.LayerHandler.LayerContainer.Objects
	if type(ref) == "number" then
		local container = objects[ref]
		if not container then
			fail(string.format("there is no item at index %d", ref))
		end
		return check(container.ItemObject)
	end

	local matches, known = {}, {}
	for _, container in ipairs(objects) do
		local itemObject = container.ItemObject
		local names = itemObject.Path.InstanceNames
		local path = itemPath(itemObject)
		table.insert(known, path)
		if
			path == ref
			or path == "game." .. ref
			or names[#names] == ref
			or (string.lower(ref) == "camera" and itemObject.Path.ItemType == "Camera")
		then
			table.insert(matches, itemObject)
		end
	end
	if #matches == 0 then
		fail(string.format("item '%s' is not in the open file (items: %s)", ref, table.concat(known, ", ")))
	elseif #matches > 1 then
		fail(string.format("item '%s' is ambiguous; use its full path or index", ref))
	end
	return check(matches[1])
end

-- Property entries ({ name, valueType, ... }) a Moon Animator item type can
-- animate. A string entry in the table refers to another type's list.
local function supportedProperties(itemType, into)
	for _, entry in ipairs(Moon.ItemTable.Items[itemType] or {}) do
		if type(entry) == "string" then
			supportedProperties(entry, into)
		else
			table.insert(into, entry)
		end
	end
	return into
end

-- Adds property tracks to an item that is already in the file (one undo step).
local function addPropertyTracks(itemObject, names)
	local list = {}
	if itemObject.RigContainer then
		table.insert(list, "Rig")
	end
	for name in pairs(itemObject.PropertyMap) do
		table.insert(list, name)
	end
	for _, name in ipairs(names) do
		table.insert(list, name)
	end
	Win.DoCompositeAction("EditItems", { ItemList = { itemObject }, PropList = list })
end

-- Returns the track and whether it is a rig joint track. A joint may be given
-- by its full hierarchy path or by a unique trailing part of it (e.g. "Head").
-- With `allowMissing`, a property the item type supports but has no track for
-- yet comes back as a stand-in { pending, itemObject, property, PropertyData },
-- enough to validate values before the caller adds the track.
local function findTrack(itemObject, spec, allowMissing)
	if spec.joint ~= nil then
		if not itemObject.RigContainer then
			fail(itemPath(itemObject) .. " has no rig joints")
		end
		local exact = itemObject.RigMap[spec.joint]
		if exact then
			return exact, true
		end
		local suffix = "." .. spec.joint
		local matches, known = {}, {}
		for name, track in pairs(itemObject.RigMap) do
			table.insert(known, name)
			if string.sub(name, -#suffix) == suffix then
				table.insert(matches, track)
			end
		end
		if #matches == 1 then
			return matches[1], true
		elseif #matches > 1 then
			fail(string.format("joint '%s' is ambiguous; use its full path", spec.joint))
		end
		table.sort(known)
		fail(string.format("unknown joint '%s' (joints: %s)", spec.joint, table.concat(known, ", ")))
	elseif spec.property ~= nil then
		local track = itemObject.PropertyMap[spec.property]
		if not track then
			for _, entry in ipairs(supportedProperties(itemObject.Path.ItemType, {})) do
				if entry[1] == spec.property then
					if allowMissing then
						return { pending = true, itemObject = itemObject, property = spec.property, PropertyData = entry }, false
					end
					fail(string.format(
						"%s has no '%s' track yet; key it with moon_set_keyframes, which adds the track",
						itemPath(itemObject),
						spec.property
					))
				end
			end
			local known = {}
			for name in pairs(itemObject.PropertyMap) do
				table.insert(known, name)
			end
			table.sort(known)
			fail(string.format(
				"property '%s' is not a track of %s (tracks: %s)",
				spec.property,
				itemPath(itemObject),
				table.concat(known, ", ")
			))
		end
		return track, false
	end
	fail("each target needs a joint or a property")
end

local EFFECTS = {
	subtitles = { "Subtitles" },
	vignette = { "Vignette" },
	letterbox = { "Letterbox", "Letterbox" },
	screen_cover = { "Screen Cover" },
}

-- Resolves "Workspace.Model.Part", "camera", or a Moon Animator effect name.
local function resolveInstance(path)
	local alias = string.lower(path)
	if alias == "camera" then
		return workspace.CurrentCamera
	end
	if EFFECTS[alias] then
		local current = game:GetService("CoreGui"):FindFirstChild("MoonAnimatorEffects")
		for _, name in ipairs(EFFECTS[alias]) do
			current = current and current:FindFirstChild(name)
		end
		if not current then
			fail("Moon Animator effect '" .. path .. "' is not available; open the Moon Animator window")
		end
		return current
	end

	local current = game
	for _, segment in ipairs(string.split(path, ".")) do
		if not (current == game and segment == "game") then
			local child = current:FindFirstChild(segment)
			if not child and current == game then
				local ok, service = pcall(game.GetService, game, segment)
				child = if ok then service else nil
			end
			if not child then
				fail(string.format("instance '%s' was not found (stopped at '%s')", path, segment))
			end
			current = child
		end
	end
	if current == game then
		fail("instance path is empty")
	end
	return current
end

local DIRECTIONS = { In = true, Out = true, InOut = true, OutIn = true }

-- nil means "no easing given". Otherwise a Moon Animator ease table.
local function decodeEase(spec)
	if spec == nil then
		return nil
	end
	local data = Ease.EASE_DATA[spec.type]
	if not data then
		local known = {}
		for name in pairs(Ease.EASE_DATA) do
			table.insert(known, name)
		end
		table.sort(known)
		fail(string.format("unknown ease type '%s' (types: %s)", tostring(spec.type), table.concat(known, ", ")))
	end
	local params
	if data.Params then
		params = {}
		if data.Params.Direction then
			params.Direction = spec.direction or "InOut"
			if not DIRECTIONS[params.Direction] then
				fail("ease direction must be In, Out, InOut or OutIn")
			end
		end
		if data.Params.Overshoot then
			params.Overshoot = spec.overshoot
		end
		if data.Params.Amplitude then
			params.Amplitude = spec.amplitude
		end
		if data.Params.Period then
			params.Period = spec.period
		end
	end
	return { _tblType = "Ease", ease_type = spec.type, params = params }
end

local function numbers(value, count, name)
	if type(value) ~= "table" or #value ~= count then
		fail(string.format("%s must be an array of %d numbers", name, count))
	end
	for i = 1, count do
		if type(value[i]) ~= "number" then
			fail(string.format("%s must be an array of %d numbers", name, count))
		end
	end
	return value
end

local function poseCFrame(position, rotation)
	local p = if position ~= nil then numbers(position, 3, "position") else { 0, 0, 0 }
	local r = if rotation ~= nil then numbers(rotation, 3, "rotation") else { 0, 0, 0 }
	return CFrame.new(p[1], p[2], p[3]) * CFrame.fromEulerAnglesXYZ(math.rad(r[1]), math.rad(r[2]), math.rad(r[3]))
end

-- Converts a keyframe spec into the value Moon Animator stores for the track.
local function decodeValue(track, isRig, spec)
	if isRig then
		-- Joints take a pose relative to rest (what a Roblox Pose.CFrame holds).
		-- Motor6D and attachment tracks store it folded into C1 / CFrame.
		local pose = poseCFrame(spec.position, spec.rotation)
		if Moon.objIsType(track, "BoneTrack") then
			return pose
		end
		return track.defaultValue * pose:Inverse()
	end

	local value = spec.value
	local valueType = track.PropertyData[2]
	local label = string.format("value for %s (%s)", track.property, valueType)
	if valueType == "number" then
		if type(value) ~= "number" then
			fail(label .. " must be a number")
		end
		return value
	elseif valueType == "boolean" then
		if type(value) ~= "boolean" then
			fail(label .. " must be true or false")
		end
		return value
	elseif valueType == "string" then
		if type(value) ~= "string" then
			fail(label .. " must be a string")
		end
		return value
	elseif valueType == "CFrame" then
		if type(value) ~= "table" or value.position == nil then
			fail(label .. " must be {position, rotation} or {position, look_at}")
		end
		if value.look_at ~= nil then
			local p = numbers(value.position, 3, "position")
			local l = numbers(value.look_at, 3, "look_at")
			if p[1] == l[1] and p[2] == l[2] and p[3] == l[3] then
				fail("look_at must differ from position")
			end
			return CFrame.lookAt(Vector3.new(p[1], p[2], p[3]), Vector3.new(l[1], l[2], l[3]))
		end
		return poseCFrame(value.position, value.rotation)
	elseif valueType == "Vector3" then
		local v = numbers(value, 3, label)
		return Vector3.new(v[1], v[2], v[3])
	elseif valueType == "Vector2" then
		local v = numbers(value, 2, label)
		return Vector2.new(v[1], v[2])
	elseif valueType == "Color3" then
		local v = numbers(value, 3, label)
		return Color3.fromRGB(v[1], v[2], v[3])
	elseif valueType == "EnumItem" then
		local enumName = track.PropertyData.SpecialEnum or track.property
		local ok, item = pcall(function()
			return Enum[enumName][value]
		end)
		if not ok or item == nil then
			fail(string.format("%s must be the name of an Enum.%s item", label, enumName))
		end
		return item
	elseif valueType == "Instance" then
		if value == nil then
			return Moon.NIL_VALUE
		end
		if type(value) ~= "string" then
			fail(label .. " must be an instance path or null")
		end
		return resolveInstance(value)
	end
	fail(string.format("values of type %s are not supported yet", valueType))
end

-- Writes keyframes as ONE entry in Moon Animator's undo history. `entries` is
-- a list of { track, frame, value, ease }; an existing keyframe on that frame
-- is updated, otherwise one is added. `deletions` is a list of keyframes to
-- remove first. Validate everything before calling: this runs through Moon
-- Animator's own composite actions, registered temporarily for the call.
local function applyKeyframes(entries, deletions)
	deletions = deletions or {}
	local doomed = {}
	for _, keyframe in ipairs(deletions) do
		doomed[keyframe] = true
	end

	local additions, edits = {}, {}
	local added, updated = 0, 0
	for _, entry in ipairs(entries) do
		local existing = entry.track.TrackItemPositions[entry.frame]
		if existing and doomed[existing] then
			existing = nil
		end
		if existing then
			if existing.width > 0 or existing.frm_pos ~= entry.frame then
				fail(string.format("frame %d is inside a grouped keyframe; ungroup it in Moon Animator first", entry.frame))
			end
			table.insert(edits, { keyframe = existing, value = entry.value, ease = entry.ease })
			updated += 1
		else
			local group = additions[entry.track]
			if not group then
				group = { Track = entry.track, TrackItems = {} }
				additions[entry.track] = group
			end
			table.insert(group.TrackItems, {
				_tblType = "Keyframe",
				frm_pos = entry.frame,
				TargetValues = entry.value,
				EaseMap = entry.ease,
			})
			added += 1
		end
	end

	local composite = Win.compositeActions
	composite.MoonBridgeBatch = function()
		local sequence = {}
		local function append(actions)
			for _, action in ipairs(actions) do
				table.insert(sequence, action)
			end
		end

		if #deletions > 0 then
			append(composite.DeleteTrackItems({ TrackItems = deletions }))
		end
		local trackTable = {}
		for _, group in pairs(additions) do
			table.insert(trackTable, group)
		end
		if #trackTable > 0 then
			append(composite.AddTrackItems({ TrackTbl = trackTable }))
		end
		for _, edit in ipairs(edits) do
			append(composite.EditKeyframes({
				TargetKeyframes = { edit.keyframe },
				TargetValues = { edit.value },
				ease = edit.ease,
			}))
		end
		return sequence
	end

	local ok, err = pcall(Win.DoCompositeAction, "MoonBridgeBatch")
	composite.MoonBridgeBatch = nil
	if not ok then
		LS.PlaybackHandler:BufferKeyframeTracks()
		error("applying keyframes failed partway; check the timeline and undo if needed: " .. tostring(err), 0)
	end
	return added, updated
end

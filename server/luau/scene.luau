--@prelude
--@targets
-- Structure of the open Moon Animator file: items, tracks, keyframes, markers.
-- Kept compact: one entry per track with parallel lists, not one object per keyframe.
requireFile()

local function triple(x, y, z)
	return { round(x), round(y), round(z) }
end

-- Values in the shapes moon_set_keyframes accepts ("<nil>" stands for a
-- cleared Instance value, which is keyed with null).
local function compact(value)
	local kind = typeof(value)
	if value == Moon.NIL_VALUE then
		return "<nil>"
	elseif kind == "CFrame" then
		local rx, ry, rz = value:ToEulerAnglesXYZ()
		return { position = triple(value.X, value.Y, value.Z), rotation = triple(math.deg(rx), math.deg(ry), math.deg(rz)) }
	elseif kind == "Vector3" then
		return triple(value.X, value.Y, value.Z)
	elseif kind == "Vector2" then
		return { round(value.X), round(value.Y) }
	elseif kind == "Color3" then
		return { math.floor(value.R * 255 + 0.5), math.floor(value.G * 255 + 0.5), math.floor(value.B * 255 + 0.5) }
	elseif kind == "Instance" then
		return value:GetFullName()
	elseif kind == "EnumItem" then
		return value.Name
	elseif kind == "number" then
		return round(value)
	elseif kind == "boolean" or kind == "string" then
		return value
	end
	return H.ser(value)
end

-- A joint pose relative to rest: rotation, plus position when it is not zero.
-- Rig tracks store joint properties (e.g. Motor6D.C1) with the pose folded in.
local function pose(track, value)
	local relative = if Moon.objIsType(track, "BoneTrack") then value else value:ToObjectSpace(track.defaultValue)
	local rx, ry, rz = relative:ToEulerAnglesXYZ()
	local entry = { rotation = triple(math.deg(rx), math.deg(ry), math.deg(rz)) }
	if relative.Position.Magnitude > 0.0005 then
		entry.position = triple(relative.X, relative.Y, relative.Z)
	end
	return entry
end

local function trackEntry(track, isRig)
	local frames, eases, values, groups = {}, {}, {}, {}
	local sameEase, grouped = true, false
	for index, keyframe in ipairs(track.TrackItems.Objects) do
		frames[index] = keyframe.frm_pos
		eases[index] = easeLabel(keyframe.EaseMap[keyframe.width])
		if eases[index] ~= eases[1] then
			sameEase = false
		end
		if keyframe.width > 0 then
			groups[tostring(keyframe.frm_pos)] = keyframe.width
			grouped = true
		end
		if ARGS.values then
			local value = keyframe.TargetValues[0]
			values[index] = if isRig and typeof(value) == "CFrame" then pose(track, value) else compact(value)
		end
	end

	local entry = { frames = frames }
	if #frames > 0 then
		if sameEase then
			entry.ease = eases[1]
		else
			entry.eases = eases
		end
	end
	if grouped then
		entry.groupWidths = groups
	end
	if ARGS.values then
		entry.values = values
	end
	if not track.Enabled then
		entry.disabled = true
	end
	return entry
end

local items = {}
for index, container in ipairs(LS.LayerHandler.LayerContainer.Objects) do
	local itemObject = container.ItemObject
	local entry = {
		index = index,
		type = itemObject.Path.ItemType,
		path = itemPath(itemObject),
		stale = staleReason(itemObject),
	}

	local properties = {}
	for name, track in pairs(itemObject.PropertyMap) do
		local property = trackEntry(track, false)
		property.type = track.PropertyData[2]
		properties[name] = property
	end
	if next(properties) ~= nil then
		entry.properties = properties
	end

	if itemObject.RigContainer then
		local keyed, unkeyed = {}, {}
		for joint, track in pairs(itemObject.RigMap) do
			if track.TrackItems.size > 0 then
				keyed[joint] = trackEntry(track, true)
			else
				table.insert(unkeyed, joint)
			end
		end
		table.sort(unkeyed)
		entry.joints = if next(keyed) ~= nil then keyed else nil
		entry.unkeyedJoints = if #unkeyed > 0 then unkeyed else nil
	end

	if itemObject.MarkerTrack then
		local markers = {}
		for _, marker in ipairs(itemObject.MarkerTrack.TrackItems.Objects) do
			local events = {}
			for _, pair in ipairs(marker.KFMarkers) do
				table.insert(events, { name = pair[1], value = pair[2] })
			end
			local runsCode = (marker.codeBegin ~= nil and marker.codeBegin ~= "")
				or (marker.codeEnd ~= nil and marker.codeEnd ~= "")
			table.insert(markers, {
				frame = marker.frm_pos,
				width = if marker.width > 0 then marker.width else nil,
				name = marker.name,
				events = if #events > 0 then events else nil,
				runsCode = if runsCode then true else nil,
			})
		end
		entry.markers = markers
	end

	table.insert(items, entry)
end

local reference = LS.CameraReferencePart
return HttpService:JSONEncode({
	file = {
		name = LS.CurrentFile.Name,
		fps = LS.FPS,
		length = LS.length,
		lastKeyframe = LS.LayerHandler:GetLastKeyframePosition(),
		frame = LS.SliderFrame,
		loop = LS.PlaybackHandler.Loop,
		exportPriority = LS.ExportPriority,
		keyframeCount = LS.KeyframeCount,
		cameraReference = if reference then reference:GetFullName() else nil,
	},
	items = items,
})

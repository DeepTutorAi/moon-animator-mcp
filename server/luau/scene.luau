--@prelude
-- Structure of the open Moon Animator file: items, tracks, keyframes, markers.
requireFile()

-- Rig tracks store joint properties (e.g. Motor6D.C1); report them as the pose
-- relative to rest, which is what a Roblox Pose.CFrame holds.
local function rigPose(track, value)
	if Moon.objIsType(track, "BoneTrack") then
		return value
	end
	return value:ToObjectSpace(track.defaultValue)
end

local function keyframes(track, isRig)
	local list = {}
	for _, keyframe in ipairs(track.TrackItems.Objects) do
		local entry = { f = keyframe.frm_pos, ease = easeLabel(keyframe.EaseMap[keyframe.width]) }
		if keyframe.width > 0 then
			entry.width = keyframe.width
		end
		if ARGS.values then
			local value = keyframe.TargetValues[0]
			if value == Moon.NIL_VALUE then
				entry.value = "<nil>"
			elseif isRig and typeof(value) == "CFrame" then
				entry.pose = H.ser(rigPose(track, value))
			else
				entry.value = H.ser(value)
			end
		end
		table.insert(list, entry)
	end
	return list
end

local items = {}
for index, container in ipairs(LS.LayerHandler.LayerContainer.Objects) do
	local itemObject = container.ItemObject
	local entry = {
		index = index,
		itemType = itemObject.Path.ItemType,
		path = table.concat(itemObject.Path.InstanceNames, "."),
		exists = itemObject.Path:GetItem() ~= nil,
	}

	local properties = {}
	for name, track in pairs(itemObject.PropertyMap) do
		table.insert(properties, {
			name = name,
			valueType = track.PropertyData[2],
			enabled = track.Enabled,
			keyframes = keyframes(track, false),
		})
	end
	table.sort(properties, function(a, b)
		return a.name < b.name
	end)
	if #properties > 0 then
		entry.properties = properties
	end

	if itemObject.RigContainer then
		local jointCount, keyed = 0, {}
		for joint, track in pairs(itemObject.RigMap) do
			jointCount += 1
			if track.TrackItems.size > 0 then
				table.insert(keyed, { joint = joint, enabled = track.Enabled, keyframes = keyframes(track, true) })
			end
		end
		table.sort(keyed, function(a, b)
			return a.joint < b.joint
		end)
		entry.rig = { jointCount = jointCount, keyedJoints = keyed }
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
				f = marker.frm_pos,
				width = marker.width,
				name = marker.name,
				events = events,
				runsCode = runsCode,
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

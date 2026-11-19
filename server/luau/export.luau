--@prelude
--@targets
-- Exports the open file with Moon Animator's own exporter (File > Export
-- Rigs): a KeyframeSequence per rig under <rig>.AnimSaves and a camera
-- animation folder under the Camera. Then reads each KeyframeSequence back and
-- compares every pose with the timeline.
requireEditable()

local fileName = LS.CurrentFile.Name
local camera = workspace.CurrentCamera

local rigs, hasCamera = {}, false
for _, container in ipairs(LS.LayerHandler.LayerContainer.Objects) do
	local itemObject = container.ItemObject
	if itemObject.RigContainer then
		local rig = itemObject.Path:GetItem()
		if rig then
			table.insert(rigs, { itemObject = itemObject, rig = rig })
		end
	elseif itemObject.Path.ItemType == "Camera" then
		hasCamera = true
	end
end
if #rigs == 0 and not hasCamera then
	fail("the open file has no rig or camera to export")
end

-- Moon Animator replaces an export of the same name; require consent for that.
local existing = {}
for _, entry in ipairs(rigs) do
	local saves = entry.rig:FindFirstChild("AnimSaves")
	if saves and saves:FindFirstChild(fileName) then
		table.insert(existing, saves[fileName]:GetFullName())
	end
end
local oldCameraExports = {}
if hasCamera then
	for _, child in ipairs(camera:GetChildren()) do
		if child:IsA("Folder") and child.Name == fileName and child:FindFirstChild("Frames") then
			table.insert(oldCameraExports, child)
			table.insert(existing, child:GetFullName())
		end
	end
end
if #existing > 0 and not ARGS.overwrite then
	fail("an export named '" .. fileName .. "' already exists (" .. table.concat(existing, ", ") .. "); pass overwrite=true to replace it")
end

local ChangeHistory = game:GetService("ChangeHistoryService")
ChangeHistory:SetWaypoint("MoonBridge: before export")
for _, old in ipairs(oldCameraExports) do
	old:Destroy()
end
Win.ExportRigs(true)
ChangeHistory:SetWaypoint("MoonBridge: export")

local function posePath(pose)
	local names = {}
	local current = pose
	-- The outermost pose is the rig's primary part and is not a joint.
	while current.Parent and current.Parent:IsA("Pose") do
		table.insert(names, 1, current.Name)
		current = current.Parent
	end
	return table.concat(names, ".")
end

local exported = {}
for _, entry in ipairs(rigs) do
	local saves = entry.rig:FindFirstChild("AnimSaves")
	local sequence = saves and saves:FindFirstChild(fileName)
	if not sequence or not sequence:IsA("KeyframeSequence") then
		fail("Moon Animator did not produce a KeyframeSequence for " .. entry.rig:GetFullName())
	end

	local keyframes, compared, unmatched = 0, 0, 0
	local worstPosition, worstAngle, lastTime = 0, 0, 0
	local events = {}
	for _, keyframe in ipairs(sequence:GetChildren()) do
		if keyframe:IsA("Keyframe") then
			keyframes += 1
			lastTime = math.max(lastTime, keyframe.Time)
			local frame = math.floor(keyframe.Time * LS.FPS + 0.5)
			if keyframe.Name ~= "Keyframe" then
				table.insert(events, { frame = frame, name = keyframe.Name })
			end
			for _, descendant in ipairs(keyframe:GetDescendants()) do
				if descendant:IsA("KeyframeMarker") then
					table.insert(events, { frame = frame, name = descendant.Name, value = descendant.Value })
				elseif descendant:IsA("Pose") and descendant.Weight > 0 and descendant.Parent:IsA("Pose") then
					local track = entry.itemObject.RigMap[posePath(descendant)]
					if not track then
						unmatched += 1
					else
						local value = if frame >= track.lastFrame then track.lastValue else track.BufferMap[frame]
						local expected = if Moon.objIsType(track, "BoneTrack") then value else value:ToObjectSpace(track.defaultValue)
						local _, angle = (descendant.CFrame.Rotation:Inverse() * expected.Rotation):ToAxisAngle()
						worstPosition = math.max(worstPosition, (descendant.CFrame.Position - expected.Position).Magnitude)
						worstAngle = math.max(worstAngle, math.deg(angle))
						compared += 1
					end
				end
			end
		end
	end

	table.insert(exported, {
		kind = "KeyframeSequence",
		path = sequence:GetFullName(),
		keyframes = keyframes,
		lengthSeconds = round(lastTime),
		loop = sequence.Loop,
		priority = sequence.Priority.Name,
		events = if #events > 0 then events else nil,
		verification = {
			posesCompared = compared,
			posesWithoutTrack = unmatched,
			worstPositionErrorStuds = round(worstPosition),
			worstAngleErrorDegrees = round(worstAngle),
		},
	})
end

if hasCamera then
	for _, child in ipairs(camera:GetChildren()) do
		if child:IsA("Folder") and child.Name == fileName and child:FindFirstChild("Frames") then
			table.insert(exported, {
				kind = "CameraAnimation",
				path = child:GetFullName(),
				frames = #child.Frames:GetChildren(),
				fovFrames = #child.FOV:GetChildren(),
			})
		end
	end
end

return HttpService:JSONEncode({
	file = fileName,
	fps = LS.FPS,
	replaced = if #existing > 0 then existing else nil,
	exported = exported,
})

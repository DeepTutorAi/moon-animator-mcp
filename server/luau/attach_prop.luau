--@prelude
--@targets
-- Joins a prop to a rig part with a Motor6D, so Moon Animator treats it as an
-- animatable joint of the rig (what its Easy Weld tool does). The prop is
-- either built from primitive parts or copied from an existing instance.
local rig = resolveInstance(ARGS.rig)
if not rig:IsA("Model") or not Moon.CheckIfRig(rig) then
	fail(ARGS.rig .. " is not a rig")
end

local hand
for _, descendant in ipairs(rig:GetDescendants()) do
	if descendant:IsA("BasePart") and descendant.Name == ARGS.attachTo then
		hand = descendant
		break
	end
end
if not hand then
	fail(string.format("%s has no part named '%s'", ARGS.rig, ARGS.attachTo))
end
for _, descendant in ipairs(rig:GetDescendants()) do
	if descendant.Name == ARGS.name or descendant.Name == ARGS.name .. "Prop" then
		fail(string.format("%s already contains something named '%s'", ARGS.rig, descendant.Name))
	end
end

-- A rig that is already in the open file only gets a track for the new joint
-- when the file is loaded again, which needs the file to be saved.
local rigIsItem = LS.CurrentFile ~= nil and LS.LayerHandler.ItemMap[rig:GetDebugId(8)] ~= nil
if rigIsItem then
	if Win.ChildModal then
		fail("a Moon Animator dialog is open; close it first")
	end
	if string.find(Win.UI.TitleBar.Title.Text, " * - ", 1, true) then
		fail("this rig is in the open file, which has unsaved changes; call moon_save first so the file can be reloaded with the new joint")
	end
end

local function cframeOf(position, rotation)
	local p = if position ~= nil then numbers(position, 3, "position") else { 0, 0, 0 }
	local r = if rotation ~= nil then numbers(rotation, 3, "rotation") else { 0, 0, 0 }
	return CFrame.new(p[1], p[2], p[3]) * CFrame.fromEulerAnglesXYZ(math.rad(r[1]), math.rad(r[2]), math.rad(r[3]))
end

local function prepare(part)
	part.Anchored = false
	part.CanCollide = false
	part.Massless = true
end

local grip = cframeOf(ARGS.grip and ARGS.grip.position, ARGS.grip and ARGS.grip.rotation)
local target = hand.CFrame * grip
local model, handle
local partCount, removedScripts = 0, 0

if ARGS.source then
	-- Copy an existing instance; the original stays where it is.
	local source = resolveInstance(ARGS.source)
	if source:IsDescendantOf(rig) then
		fail("the source is already part of this rig")
	end
	local copy = source:Clone()
	if not copy then
		fail(ARGS.source .. " cannot be copied (it is not archivable)")
	end

	if copy:IsA("Model") then
		model = copy
	else
		model = Instance.new("Model")
		if copy:IsA("BasePart") then
			copy.Parent = model
		else
			for _, child in ipairs(copy:GetChildren()) do
				child.Parent = model
			end
			copy:Destroy()
		end
	end
	model.Name = ARGS.name .. "Prop"

	local parts = {}
	for _, descendant in ipairs(model:GetDescendants()) do
		if descendant:IsA("LuaSourceContainer") then
			-- Scripts inside a prop would run inside the character at runtime.
			removedScripts += 1
			descendant:Destroy()
		elseif descendant:IsA("BasePart") then
			table.insert(parts, descendant)
		end
	end
	if #parts == 0 then
		model:Destroy()
		fail(ARGS.source .. " contains no parts")
	end
	partCount = #parts

	if ARGS.handle then
		for _, part in ipairs(parts) do
			if part.Name == ARGS.handle then
				handle = part
				break
			end
		end
		if not handle then
			model:Destroy()
			fail(string.format("%s has no part named '%s' to use as the handle", ARGS.source, ARGS.handle))
		end
	else
		handle = model.PrimaryPart
		if not handle then
			for _, part in ipairs(parts) do
				if part.Name == "Handle" then
					handle = part
					break
				end
			end
		end
		handle = handle or parts[1]
	end

	-- Move the whole prop rigidly so the handle sits in the grip, then make it one rigid piece.
	local shift = target * handle.CFrame:Inverse()
	for _, part in ipairs(parts) do
		part.CFrame = shift * part.CFrame
		prepare(part)
	end
	for _, part in ipairs(parts) do
		if part ~= handle then
			local weld = Instance.new("WeldConstraint")
			weld.Name = "PropWeld"
			weld.Part0 = handle
			weld.Part1 = part
			weld.Parent = part
		end
	end
	handle.Name = ARGS.name
else
	local SHAPES = { Block = Enum.PartType.Block, Ball = Enum.PartType.Ball, Cylinder = Enum.PartType.Cylinder }
	model = Instance.new("Model")
	model.Name = ARGS.name .. "Prop"

	-- The first part is the handle the joint drives; the rest are welded to it.
	for index, spec in ipairs(ARGS.parts) do
		local shape = SHAPES[spec.shape or "Block"]
		if not shape then
			model:Destroy()
			fail("part shape must be Block, Ball or Cylinder")
		end
		local size = numbers(spec.size, 3, "size")

		local part = Instance.new("Part")
		part.Name = if index == 1 then ARGS.name else string.format("%s_%d", ARGS.name, index)
		part.Shape = shape
		part.Size = Vector3.new(size[1], size[2], size[3])
		part.TopSurface = Enum.SurfaceType.Smooth
		part.BottomSurface = Enum.SurfaceType.Smooth
		prepare(part)
		if spec.color then
			local c = numbers(spec.color, 3, "color")
			part.Color = Color3.fromRGB(c[1], c[2], c[3])
		end
		if spec.material then
			local ok, material = pcall(function()
				return Enum.Material[spec.material]
			end)
			if not ok or material == nil then
				model:Destroy()
				fail("unknown material '" .. tostring(spec.material) .. "'")
			end
			part.Material = material
		end

		if index == 1 then
			handle = part
			part.CFrame = target
		else
			part.CFrame = handle.CFrame * cframeOf(spec.offset, spec.rotation)
			local weld = Instance.new("WeldConstraint")
			weld.Part0 = handle
			weld.Part1 = part
			weld.Parent = part
		end
		part.Parent = model
	end
	partCount = #ARGS.parts
end

local ChangeHistory = game:GetService("ChangeHistoryService")
ChangeHistory:SetWaypoint("MoonBridge: before attach prop")

model.PrimaryPart = handle
model.Parent = rig

local motor = Instance.new("Motor6D")
motor.Name = ARGS.name
motor.Part0 = hand
motor.Part1 = handle
motor.C0 = grip
motor.Parent = hand

ChangeHistory:SetWaypoint("MoonBridge: attach prop")

-- Load the file again so the rig item picks up the new joint. Keyframes are
-- kept (they are stored by joint path); Moon Animator's undo history is not.
local reloaded = false
if rigIsItem then
	local file = LS.CurrentFile
	Win.CloseFile()
	if not Win.OpenFile(file) then
		fail("the prop was attached, but Moon Animator could not reopen '" .. file.Name .. "'; open it again from the Moon Animator window")
	end
	reloaded = true
end

return HttpService:JSONEncode({
	prop = ARGS.rig .. "." .. model.Name,
	joint = ARGS.name,
	attachedTo = hand.Name,
	parts = partCount,
	copiedFrom = ARGS.source,
	removedScripts = if removedScripts > 0 then removedScripts else nil,
	reloadedFile = reloaded,
})

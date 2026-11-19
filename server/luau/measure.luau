-- Measuring helpers: world-space bounds and part positions of an item's
-- instance. Requires prelude.luau and targets.luau before it.
local RunService = game:GetService("RunService")

-- Rigs jointed with AnimationConstraints are moved by the engine's solver on
-- its next step, not at the moment a joint value is written, so positions read
-- straight after a pose change would be those of the previous pose. Returns a
-- function to call between changing the pose and measuring; it does nothing
-- for rigs whose joints (Motor6D, Bone) take effect immediately.
local SOLVER_STEPS = 1
local function poseSettler(...)
	local needed = false
	for _, instance in ipairs({ ... }) do
		if instance:FindFirstChildWhichIsA("AnimationConstraint", true) then
			needed = true
		end
	end
	if not needed then
		return function() end
	end
	return function()
		for _ = 1, SOLVER_STEPS do
			RunService.Heartbeat:Wait()
		end
	end
end

-- World CFrame of a part, or of a bone as it is posed.
local function worldCFrame(point)
	return if point:IsA("Bone") then point.TransformedWorldCFrame else point.CFrame
end

local function visibleParts(instance)
	local parts = {}
	local function consider(part)
		if part:IsA("BasePart") and part.Transparency < 1 then
			table.insert(parts, part)
		end
	end
	consider(instance)
	for _, descendant in ipairs(instance:GetDescendants()) do
		consider(descendant)
	end
	return parts
end

-- The part that defines which way the instance faces.
local function referencePart(instance)
	if instance:IsA("Model") then
		return instance.PrimaryPart or instance:FindFirstChildWhichIsA("BasePart", true)
	elseif instance:IsA("BasePart") then
		return instance
	end
	return nil
end

local function measurable(itemObject)
	local instance = itemObject.Path:GetItem()
	if not instance then
		fail(itemPath(itemObject) .. " no longer exists in the place")
	end
	if not referencePart(instance) then
		fail(itemPath(itemObject) .. " has no parts to measure")
	end
	return instance
end

-- Returns { min, max, parts } for the instance as it is posed right now.
-- `wanted` limits the reported parts by name; `relativeTo` reports positions
-- in that part's local space instead of world space. Bones widen the bounds
-- (a skinned mesh part does not move with its bones) and are reported when
-- asked for by name.
local function measure(instance, wanted, relativeTo)
	local minX, minY, minZ = math.huge, math.huge, math.huge
	local maxX, maxY, maxZ = -math.huge, -math.huge, -math.huge
	local positions = {}
	local function report(name, position)
		if relativeTo then
			position = worldCFrame(relativeTo):PointToObjectSpace(position)
		end
		positions[name] = { round(position.X), round(position.Y), round(position.Z) }
	end

	for _, part in ipairs(visibleParts(instance)) do
		local x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 = part.CFrame:GetComponents()
		local size = part.Size
		local ex = (math.abs(r00) * size.X + math.abs(r01) * size.Y + math.abs(r02) * size.Z) / 2
		local ey = (math.abs(r10) * size.X + math.abs(r11) * size.Y + math.abs(r12) * size.Z) / 2
		local ez = (math.abs(r20) * size.X + math.abs(r21) * size.Y + math.abs(r22) * size.Z) / 2
		minX, minY, minZ = math.min(minX, x - ex), math.min(minY, y - ey), math.min(minZ, z - ez)
		maxX, maxY, maxZ = math.max(maxX, x + ex), math.max(maxY, y + ey), math.max(maxZ, z + ez)

		if wanted == nil or wanted[part.Name] then
			report(part.Name, part.Position)
		end
	end
	for _, descendant in ipairs(instance:GetDescendants()) do
		if descendant:IsA("Bone") then
			local position = descendant.TransformedWorldCFrame.Position
			minX, minY, minZ = math.min(minX, position.X), math.min(minY, position.Y), math.min(minZ, position.Z)
			maxX, maxY, maxZ = math.max(maxX, position.X), math.max(maxY, position.Y), math.max(maxZ, position.Z)
			if wanted ~= nil and wanted[descendant.Name] then
				report(descendant.Name, position)
			end
		end
	end

	return {
		min = { round(minX), round(minY), round(minZ) },
		max = { round(maxX), round(maxY), round(maxZ) },
		parts = positions,
	}
end

local function facingOf(instance)
	local cframe = referencePart(instance).CFrame
	local look, right = cframe.LookVector, cframe.RightVector
	return {
		look = { round(look.X), round(look.Y), round(look.Z) },
		right = { round(right.X), round(right.Y), round(right.Z) },
	}
end

-- A part by name, or failing that a bone. Joints often share the name of the
-- part they drive, so a plain FindFirstChild could return the joint instead.
local function findPart(instance, name)
	if instance:IsA("BasePart") and instance.Name == name then
		return instance
	end
	local bone
	for _, descendant in ipairs(instance:GetDescendants()) do
		if descendant.Name == name then
			if descendant:IsA("BasePart") then
				return descendant
			elseif descendant:IsA("Bone") then
				bone = bone or descendant
			end
		end
	end
	return bone
end

-- Turns a list of part names into a lookup, checking that each exists.
local function partFilter(instance, names)
	if names == nil then
		return nil
	end
	local wanted = {}
	for _, name in ipairs(names) do
		if not findPart(instance, name) then
			fail(string.format("'%s' is not a part or bone of %s", tostring(name), instance:GetFullName()))
		end
		wanted[name] = true
	end
	return wanted
end

-- The part positions are reported relative to: a part of the measured
-- instance, or of another item of the file when `itemRef` is given. Returns
-- the part and the instance that owns it.
local function relativePart(instance, name, itemRef)
	if name == nil then
		if itemRef ~= nil then
			fail("relative_to_item needs relative_to, the name of a part of that item")
		end
		return nil, nil
	end
	local owner = if itemRef ~= nil then measurable(findItem(itemRef)) else instance
	local part = findPart(owner, name)
	if not part then
		fail(string.format("relative_to '%s' is not a part or bone of %s", tostring(name), owner:GetFullName()))
	end
	return part, owner
end

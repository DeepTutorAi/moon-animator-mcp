-- Measuring helpers: world-space bounds and part positions of an item's
-- instance. Requires prelude.luau and targets.luau before it.

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
-- in that part's local space instead of world space.
local function measure(instance, wanted, relativeTo)
	local minX, minY, minZ = math.huge, math.huge, math.huge
	local maxX, maxY, maxZ = -math.huge, -math.huge, -math.huge
	local positions = {}

	for _, part in ipairs(visibleParts(instance)) do
		local x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 = part.CFrame:GetComponents()
		local size = part.Size
		local ex = (math.abs(r00) * size.X + math.abs(r01) * size.Y + math.abs(r02) * size.Z) / 2
		local ey = (math.abs(r10) * size.X + math.abs(r11) * size.Y + math.abs(r12) * size.Z) / 2
		local ez = (math.abs(r20) * size.X + math.abs(r21) * size.Y + math.abs(r22) * size.Z) / 2
		minX, minY, minZ = math.min(minX, x - ex), math.min(minY, y - ey), math.min(minZ, z - ez)
		maxX, maxY, maxZ = math.max(maxX, x + ex), math.max(maxY, y + ey), math.max(maxZ, z + ez)

		if wanted == nil or wanted[part.Name] then
			local position = part.Position
			if relativeTo then
				position = relativeTo.CFrame:PointToObjectSpace(position)
			end
			positions[part.Name] = { round(position.X), round(position.Y), round(position.Z) }
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

-- A part by name. Joints often share the name of the part they drive, so a
-- plain FindFirstChild could return the joint instead.
local function findPart(instance, name)
	if instance:IsA("BasePart") and instance.Name == name then
		return instance
	end
	for _, descendant in ipairs(instance:GetDescendants()) do
		if descendant:IsA("BasePart") and descendant.Name == name then
			return descendant
		end
	end
	return nil
end

-- Turns a list of part names into a lookup, checking that each exists.
local function partFilter(instance, names)
	if names == nil then
		return nil
	end
	local wanted = {}
	for _, name in ipairs(names) do
		if not findPart(instance, name) then
			fail(string.format("'%s' is not a part of %s", tostring(name), instance:GetFullName()))
		end
		wanted[name] = true
	end
	return wanted
end

local function relativePart(instance, name)
	if name == nil then
		return nil
	end
	local part = findPart(instance, name)
	if not part then
		fail(string.format("relative_to '%s' is not a part of %s", tostring(name), instance:GetFullName()))
	end
	return part
end

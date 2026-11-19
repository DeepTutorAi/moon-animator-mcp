--@prelude
--@targets
-- Places one of Moon Animator's built-in rigs (the Character Inserter rigs) in the workspace.
local template = Moon.rigs:FindFirstChild(ARGS.kind)
if not template or not template:IsA("Model") then
	local kinds = {}
	for _, child in ipairs(Moon.rigs:GetChildren()) do
		table.insert(kinds, child.Name)
	end
	table.sort(kinds)
	fail(string.format("unknown rig kind '%s' (kinds: %s)", tostring(ARGS.kind), table.concat(kinds, ", ")))
end
if workspace:FindFirstChild(ARGS.name) then
	fail(string.format("Workspace already has something named '%s'", ARGS.name))
end

local ChangeHistory = game:GetService("ChangeHistoryService")
ChangeHistory:SetWaypoint("MoonBridge: before insert rig")

local rig = template:Clone()
rig.Name = ARGS.name
rig.Parent = workspace

-- `position` is where the feet go; `facing` turns the rig around the vertical axis.
local feet = Vector3.new(ARGS.position[1], ARGS.position[2], ARGS.position[3])
rig:PivotTo(CFrame.new(feet) * CFrame.Angles(0, math.rad(ARGS.facing or 0), 0))
local boxCFrame, boxSize = rig:GetBoundingBox()
local bottom = boxCFrame.Position.Y - boxSize.Y / 2
rig:PivotTo(rig:GetPivot() + Vector3.new(0, feet.Y - bottom, 0))

ChangeHistory:SetWaypoint("MoonBridge: insert rig")

local parts = {}
for _, descendant in ipairs(rig:GetDescendants()) do
	if descendant:IsA("BasePart") then
		table.insert(parts, descendant.Name)
	end
end
table.sort(parts)
local pivot = rig:GetPivot().Position
return HttpService:JSONEncode({
	path = "Workspace." .. rig.Name,
	primaryPart = rig.PrimaryPart.Name,
	pivot = { round(pivot.X), round(pivot.Y), round(pivot.Z) },
	height = round(boxSize.Y),
	parts = parts,
})

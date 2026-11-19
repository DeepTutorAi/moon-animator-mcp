--@prelude
--@targets
-- Adds instances to the open file as Moon Animator items (one undo step each).
requireEditable()
if LS.RigOnlyMode then
	fail("the open file is a rig-only file; convert it to a Moon 2 file in Moon Animator first")
end

local Path = require(Moon.class.Path)

-- Property names a type supports. A string entry refers to another type's list.
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

local plans = {}
for _, spec in ipairs(ARGS.items) do
	local instance = resolveInstance(spec.path)
	local itemType = Moon.ItemTable.GetItemType(instance)
	local supported = supportedProperties(itemType, {})
	if #supported == 0 then
		fail(string.format("%s (%s) cannot be animated by Moon Animator", spec.path, instance.ClassName))
	end
	if LS.LayerHandler.ItemMap[instance:GetDebugId(8)] ~= nil then
		fail(spec.path .. " is already an item in the open file")
	end
	if instance ~= workspace.CurrentCamera and not Path.CheckIfUnique(instance) then
		fail(spec.path .. " shares its name with a sibling; Moon Animator needs unique names along the path")
	end

	local properties = spec.properties
	if not properties then
		properties = {}
		for index, entry in ipairs(supported) do
			if index == 1 or entry.def then
				table.insert(properties, entry[1])
			end
		end
	else
		local valid = {}
		for _, entry in ipairs(supported) do
			valid[entry[1]] = true
		end
		for _, name in ipairs(properties) do
			if not valid[name] then
				local names = {}
				for _, entry in ipairs(supported) do
					table.insert(names, entry[1])
				end
				fail(string.format("'%s' is not animatable on %s (available: %s)", name, itemType, table.concat(names, ", ")))
			end
		end
	end
	table.insert(plans, { instance = instance, properties = properties, markers = spec.markers == true })
end

local added = {}
for _, plan in ipairs(plans) do
	Win.DoCompositeAction("AddItems", { ItemList = { plan.instance }, PropList = plan.properties, MarkerTrack = plan.markers })
	local itemObject = LS.LayerHandler.ItemMap[plan.instance:GetDebugId(8)]
	local joints = {}
	if itemObject.RigContainer then
		for name in pairs(itemObject.RigMap) do
			table.insert(joints, name)
		end
		table.sort(joints)
	end
	table.insert(added, {
		path = itemPath(itemObject),
		itemType = itemObject.Path.ItemType,
		properties = plan.properties,
		joints = if #joints > 0 then joints else nil,
	})
end

return HttpService:JSONEncode({ added = added })

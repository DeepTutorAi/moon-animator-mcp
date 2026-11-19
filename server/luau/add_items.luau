--@prelude
--@targets
-- Adds instances to the open file as Moon Animator items (one undo step each).
-- For an instance that is already an item, adds the listed property tracks.
requireEditable()
if LS.RigOnlyMode then
	fail("the open file is a rig-only file; convert it to a Moon 2 file in Moon Animator first")
end

local Path = require(Moon.class.Path)

local plans = {}
for _, spec in ipairs(ARGS.items) do
	local instance = resolveInstance(spec.path)
	local itemType = Moon.ItemTable.GetItemType(instance)
	local supported = supportedProperties(itemType, {})
	if #supported == 0 then
		fail(string.format("%s (%s) cannot be animated by Moon Animator", spec.path, instance.ClassName))
	end
	local valid, names = {}, {}
	for _, entry in ipairs(supported) do
		valid[entry[1]] = true
		table.insert(names, entry[1])
	end
	for _, name in ipairs(spec.properties or {}) do
		if not valid[name] then
			fail(string.format("'%s' is not animatable on %s (available: %s)", name, itemType, table.concat(names, ", ")))
		end
	end

	local existing = LS.LayerHandler.ItemMap[instance:GetDebugId(8)]
	if existing then
		local missing = {}
		for _, name in ipairs(spec.properties or {}) do
			if not existing.PropertyMap[name] then
				table.insert(missing, name)
			end
		end
		if #missing == 0 then
			fail(spec.path .. " is already an item in the open file; list properties to add more tracks to it")
		end
		table.insert(plans, { existing = existing, properties = missing })
	else
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
		end
		table.insert(plans, { instance = instance, properties = properties, markers = spec.markers == true })
	end
end

local added = {}
for _, plan in ipairs(plans) do
	local itemObject = plan.existing
	if itemObject then
		addPropertyTracks(itemObject, plan.properties)
	else
		Win.DoCompositeAction("AddItems", { ItemList = { plan.instance }, PropList = plan.properties, MarkerTrack = plan.markers })
		itemObject = LS.LayerHandler.ItemMap[plan.instance:GetDebugId(8)]
	end
	local joints = {}
	if itemObject.RigContainer and not plan.existing then
		for name in pairs(itemObject.RigMap) do
			table.insert(joints, name)
		end
		table.sort(joints)
	end
	table.insert(added, {
		path = itemPath(itemObject),
		itemType = itemObject.Path.ItemType,
		alreadyAnItem = if plan.existing then true else nil,
		properties = plan.properties,
		joints = if #joints > 0 then joints else nil,
	})
end

return HttpService:JSONEncode({ added = added })

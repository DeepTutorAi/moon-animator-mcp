--@prelude
--@targets
-- Removes items from the open file as one undo step. The instances stay in
-- the place; only their tracks and keyframes leave the file.
requireEditable()

local targets, seen, removed = {}, {}, {}
for _, ref in ipairs(ARGS.items) do
	-- An item whose instance is gone or was replaced can still be removed.
	local itemObject = findItem(ref, true)
	if seen[itemObject] then
		fail(string.format("item '%s' is listed twice", tostring(ref)))
	end
	seen[itemObject] = true
	table.insert(targets, itemObject)
	table.insert(removed, itemPath(itemObject))
end

-- Removing an item clears the index entry of its instance. When a second item
-- shares that instance (a leftover of a close that failed partway), the entry
-- belongs to the other item and is put back afterwards.
local map = LS.LayerHandler.ItemMap
local shared = {}
for _, itemObject in ipairs(targets) do
	rekeyItem(itemObject)
	local instance = itemObject.Path:GetItem()
	local key = instance and instance:GetDebugId(8)
	if key and map[key] ~= itemObject and not seen[map[key]] then
		shared[key] = map[key]
	end
end
Win.DoCompositeAction("RemoveItems", { ItemList = targets })
for key, owner in pairs(shared) do
	map[key] = owner
end

return HttpService:JSONEncode({
	removed = removed,
	itemCount = LS.LayerHandler.LayerContainer.size,
	keyframeCount = LS.KeyframeCount,
})

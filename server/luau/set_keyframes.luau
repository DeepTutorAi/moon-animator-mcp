--@prelude
--@targets
-- Adds or updates keyframes as one undoable Moon Animator action. A property
-- the item supports but has no track for yet gets its track first (a second
-- undo step), once every keyframe has been validated.
requireEditable()

local entries, seen = {}, {}
local pending = {} -- [itemObject] = { [property] = stand-in track }
for _, spec in ipairs(ARGS.keyframes) do
	local itemObject = findItem(spec.item)
	local track, isRig = findTrack(itemObject, spec, true)
	if track.pending then
		pending[itemObject] = pending[itemObject] or {}
		track = pending[itemObject][spec.property] or track
		pending[itemObject][spec.property] = track
	end
	local frame = spec.frame
	if frame > LS.length then
		fail(string.format("frame %d is beyond the timeline length %d; extend it with moon_settings first", frame, LS.length))
	end

	local key = tostring(track) .. ":" .. frame
	if seen[key] then
		fail(string.format("frame %d is listed twice for the same track", frame))
	end
	seen[key] = true

	table.insert(entries, {
		track = track,
		frame = frame,
		value = decodeValue(track, isRig, spec),
		ease = decodeEase(spec.ease),
	})
end

local addedTracks = {}
for itemObject, properties in pairs(pending) do
	local names = {}
	for name in pairs(properties) do
		table.insert(names, name)
	end
	table.sort(names)
	addPropertyTracks(itemObject, names)
	for _, name in ipairs(names) do
		table.insert(addedTracks, itemPath(itemObject) .. "." .. name)
	end
end
for _, entry in ipairs(entries) do
	if entry.track.pending then
		entry.track = entry.track.itemObject.PropertyMap[entry.track.property]
	end
end

local added, updated = applyKeyframes(entries)

return HttpService:JSONEncode({
	added = added,
	updated = updated,
	addedTracks = if #addedTracks > 0 then addedTracks else nil,
	keyframeCount = LS.KeyframeCount,
	lastKeyframe = LS.LayerHandler:GetLastKeyframePosition(),
})

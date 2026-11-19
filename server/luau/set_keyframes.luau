--@prelude
--@targets
-- Adds or updates keyframes as one undoable Moon Animator action.
requireEditable()

local entries, seen = {}, {}
for _, spec in ipairs(ARGS.keyframes) do
	local itemObject = findItem(spec.item)
	local track, isRig = findTrack(itemObject, spec)
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

local added, updated = applyKeyframes(entries)

return HttpService:JSONEncode({
	added = added,
	updated = updated,
	keyframeCount = LS.KeyframeCount,
	lastKeyframe = LS.LayerHandler:GetLastKeyframePosition(),
})

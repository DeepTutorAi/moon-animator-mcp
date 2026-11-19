--@prelude
--@targets
-- Deletes keyframes as one undoable Moon Animator action.
requireEditable()

local doomed = {}
for _, target in ipairs(ARGS.targets) do
	local track = findTrack(findItem(target.item), target)
	if target.frames then
		for _, frame in ipairs(target.frames) do
			local keyframe = track.TrackItemPositions[frame]
			if not keyframe or keyframe.frm_pos ~= frame then
				fail(string.format("there is no keyframe starting at frame %d on that track", frame))
			end
			table.insert(doomed, keyframe)
		end
	else
		for _, keyframe in ipairs(track.TrackItems.Objects) do
			table.insert(doomed, keyframe)
		end
	end
end

if #doomed > 0 then
	Win.DoCompositeAction("DeleteTrackItems", { TrackItems = doomed })
end

return HttpService:JSONEncode({
	deleted = #doomed,
	keyframeCount = LS.KeyframeCount,
	lastKeyframe = LS.LayerHandler:GetLastKeyframePosition(),
})

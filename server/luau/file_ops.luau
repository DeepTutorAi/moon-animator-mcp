--@prelude
--@targets
-- Save, timeline settings, undo and redo for the open file.
requireEditable()

local result = {}

if ARGS.op == "save" then
	local file = LS.CurrentFile
	if file.Parent == nil then
		local folder = Moon.Files.GetRoot()
		file.Parent = folder
		if folder.Parent == nil then
			folder.Parent = game:GetService("ServerStorage")
		end
	end
	Win.SaveFile(true)
	result.saved = LS.CurrentFile:GetFullName()
elseif ARGS.op == "settings" then
	local change = {}
	if ARGS.length ~= nil then
		local lastKeyframe = LS.LayerHandler:GetLastKeyframePosition()
		if ARGS.length < Moon.MIN_FRAMES or ARGS.length > Moon.MAX_FRAMES then
			fail(string.format("length must be between %d and %d frames", Moon.MIN_FRAMES, Moon.MAX_FRAMES))
		end
		if ARGS.length < lastKeyframe then
			fail(string.format("length %d would cut off keyframes (last keyframe is at %d)", ARGS.length, lastKeyframe))
		end
		change.length = ARGS.length
	end
	if ARGS.loop ~= nil then
		change.Loop = ARGS.loop
	end
	if ARGS.priority ~= nil then
		local ok, item = pcall(function()
			return Enum.AnimationPriority[ARGS.priority]
		end)
		if not ok or item == nil then
			fail("priority must be the name of an Enum.AnimationPriority item, e.g. Action")
		end
		change.Priority = ARGS.priority
	end
	if next(change) ~= nil then
		Win.DoCompositeAction("EditAnimationSettings", change)
	end
elseif ARGS.op == "undo" or ARGS.op == "redo" then
	-- Moon Animator keeps its undo and redo functions in the main window
	-- module's environment; its keyboard actions only run while the window has focus.
	local environment = getfenv(Win.DoCompositeAction)
	local step = if ARGS.op == "undo" then environment.UndoAction else environment.RedoAction
	if type(step) ~= "function" then
		fail("this Moon Animator version does not expose its undo functions")
	end
	for _ = 1, ARGS.steps do
		step()
	end
else
	fail("unknown operation")
end

result.file = LS.CurrentFile.Name
result.fps = LS.FPS
result.length = LS.length
result.loop = LS.PlaybackHandler.Loop
result.priority = LS.ExportPriority
result.keyframeCount = LS.KeyframeCount
result.lastKeyframe = LS.LayerHandler:GetLastKeyframePosition()
result.unsavedChanges = string.find(Win.UI.TitleBar.Title.Text, " * - ", 1, true) ~= nil
return HttpService:JSONEncode(result)

--@prelude
--@targets
-- Opens a Moon Animator file by name, optionally creating it.
local function isDirty()
	return LS.CurrentFile ~= nil and string.find(Win.UI.TitleBar.Title.Text, " * - ", 1, true) ~= nil
end

local ServerStorage = game:GetService("ServerStorage")
local root = ServerStorage:FindFirstChild("MoonAnimator2Saves")
local existing
local available = {}
if root then
	for _, descendant in ipairs(root:GetDescendants()) do
		if descendant:IsA("StringValue") and descendant.Parent:IsA("Folder") and Moon.Files.OpenFile(descendant) then
			table.insert(available, descendant.Name)
			if descendant.Name == ARGS.name then
				existing = descendant
			end
		end
	end
end

-- Opening the file that is already open reloads it from its saved state, which
-- drops unsaved edits and links every item to the instances now in the place.
local reloaded = LS.CurrentFile ~= nil and LS.CurrentFile == existing
if not existing and not ARGS.create then
	table.sort(available)
	fail(string.format(
		"there is no Moon Animator file named '%s' (files: %s); pass create=true to make it",
		ARGS.name,
		if #available > 0 then table.concat(available, ", ") else "none"
	))
end
if isDirty() and not ARGS.discardChanges then
	fail(string.format(
		"'%s' has unsaved changes; call moon_save first or pass discard_changes=true",
		LS.CurrentFile.Name
	))
end
if Win.ChildModal then
	fail("a Moon Animator dialog is open; close it first")
end

-- Moon Animator only opens a file from its closed state, which also clears its undo history.
if LS.CurrentFile then
	closeFile()
end

local created = false
local file = existing
if not file then
	file = Moon.Files.NewFile(ARGS.name, "moon2")
	created = true
end
if not Win.OpenFile(file, created) then
	fail("Moon Animator could not open '" .. ARGS.name .. "'")
end
if created then
	local folder = Moon.Files.GetRoot()
	LS.CurrentFile.Parent = folder
	if folder.Parent == nil then
		folder.Parent = ServerStorage
	end
	Win.SaveFile(true)
end

return HttpService:JSONEncode({
	name = LS.CurrentFile.Name,
	created = created,
	reloaded = if reloaded then true else nil,
	fps = LS.FPS,
	length = LS.length,
	itemCount = LS.LayerHandler.LayerContainer.size,
})

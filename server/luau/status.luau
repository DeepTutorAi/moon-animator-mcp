local H = ...
local camera = workspace.CurrentCamera
local report = H.report()
report.studioMode = if game:GetService("RunService"):IsRunning() then "running" else "edit"
report.viewport = { width = camera.ViewportSize.X, height = camera.ViewportSize.Y }
report.camera = { cframe = camera.CFrame, fov = camera.FieldOfView }

-- Mark items whose tracks no longer drive anything: the instance was deleted,
-- or replaced by another one of the same name after the file was opened.
local Moon = _G.MoonGlobal
if report.items and Moon and Moon.ready then
	local handler = Moon.Windows.MoonAnimator.g_e.LayerSystem.LayerHandler
	for index, container in ipairs(handler.LayerContainer.Objects) do
		local entry = report.items[index]
		local itemObject = container.ItemObject
		local instance = itemObject.Path:GetItem()
		if entry and not instance then
			entry.stale = "missing"
		elseif entry and handler.ItemMap[instance:GetDebugId(8)] ~= itemObject then
			entry.stale = "replaced"
		end
	end
end
return report

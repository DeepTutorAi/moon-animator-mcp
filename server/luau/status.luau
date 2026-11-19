local H = ...
local camera = workspace.CurrentCamera
local report = H.report()
report.studioMode = if game:GetService("RunService"):IsRunning() then "running" else "edit"
report.viewport = { width = camera.ViewportSize.X, height = camera.ViewportSize.Y }
report.camera = { cframe = camera.CFrame, fov = camera.FieldOfView }
return report

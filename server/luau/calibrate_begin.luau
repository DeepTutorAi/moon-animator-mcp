--@settle
-- Covers the 3D viewport with a solid marker so the capture side can locate it.
local CoreGui = game:GetService("CoreGui")
local existing = CoreGui:FindFirstChild("MoonBridgeCalibration")
if existing then
	existing:Destroy()
end

local gui = Instance.new("ScreenGui")
gui.Name = "MoonBridgeCalibration"
gui.IgnoreGuiInset = true
gui.DisplayOrder = 2147483647
gui.Archivable = false

local marker = Instance.new("Frame")
marker.Size = UDim2.fromScale(1, 1)
marker.BorderSizePixel = 0
marker.BackgroundColor3 = Color3.fromRGB(ARGS.color[1], ARGS.color[2], ARGS.color[3])
marker.Parent = gui
gui.Parent = CoreGui

local settled = settle(3)
local size = workspace.CurrentCamera.ViewportSize
return { width = size.X, height = size.Y, settled = settled }

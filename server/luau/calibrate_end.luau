--@settle
local existing = game:GetService("CoreGui"):FindFirstChild("MoonBridgeCalibration")
if existing then
	existing:Destroy()
end
return settle(3)

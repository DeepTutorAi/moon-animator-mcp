-- Waits until the viewport has redrawn `count` times, or two seconds pass.
-- Heartbeat keeps its pace while Studio renders at a reduced rate in the
-- background, so only counting rendered frames guarantees that a capture
-- taken afterwards shows the current state. Returns false on timeout.
local function settle(count)
	local rendered = 0
	local connection = game:GetService("RunService").RenderStepped:Connect(function()
		rendered += 1
	end)
	local deadline = os.clock() + 2
	while rendered < count and os.clock() < deadline do
		task.wait()
	end
	connection:Disconnect()
	return rendered >= count
end

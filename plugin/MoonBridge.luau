--!nonstrict
-- MoonBridge
-- Connects Roblox Studio (edit mode) to the local moon-animator-mcp bridge
-- over HTTP long-polling on 127.0.0.1. Runs the Luau snippets the server
-- sends, which drive Moon Animator 2 through _G.MoonGlobal. Moon Animator
-- itself is never modified and is not included.

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

if RunService:IsRunning() then
	return
end

local BRIDGE_VERSION = "0.1.0"
local PORT = tonumber("@@PORT@@")
local TOKEN = "@@TOKEN@@"
local BASE_URL = string.format("http://127.0.0.1:%d", PORT)
local RETRY_SECONDS = 3
local DEFAULT_EXEC_TIMEOUT = 30
local MAX_TABLE_ENTRIES = 500

local unloading = false
plugin.Unloading:Connect(function()
	unloading = true
end)

------------------------------------------------------------
-- Serialization: turns Luau/Roblox values into JSON-safe data.

local function round(n)
	return math.floor(n * 10000 + 0.5) / 10000
end

local function ser(value, depth, seen)
	depth = depth or 5
	local t = typeof(value)

	if t == "nil" or t == "boolean" or t == "string" then
		return value
	elseif t == "number" then
		if value ~= value or value == math.huge or value == -math.huge then
			return tostring(value)
		end
		return value
	elseif t == "CFrame" then
		local rx, ry, rz = value:ToEulerAnglesXYZ()
		return {
			t = "CFrame",
			p = { round(value.X), round(value.Y), round(value.Z) },
			r = { round(math.deg(rx)), round(math.deg(ry)), round(math.deg(rz)) },
		}
	elseif t == "Vector3" then
		return { t = "Vector3", v = { round(value.X), round(value.Y), round(value.Z) } }
	elseif t == "Vector2" then
		return { t = "Vector2", v = { round(value.X), round(value.Y) } }
	elseif t == "Color3" then
		return { t = "Color3", v = { round(value.R), round(value.G), round(value.B) } }
	elseif t == "Instance" then
		local ok, path = pcall(value.GetFullName, value)
		return { t = "Instance", class = value.ClassName, path = ok and path or "<destroyed>" }
	elseif t == "table" then
		seen = seen or {}
		if seen[value] then
			return "<cycle>"
		end
		if depth <= 0 then
			return "<table>"
		end
		seen[value] = true

		local length = #value
		local count = 0
		for _ in pairs(value) do
			count += 1
		end

		local out = {}
		if length > 0 and count == length then
			for i = 1, math.min(length, MAX_TABLE_ENTRIES) do
				local item = ser(value[i], depth - 1, seen)
				out[i] = if item == nil then "<nil>" else item
			end
		else
			local written = 0
			for k, v in pairs(value) do
				if written >= MAX_TABLE_ENTRIES then
					out.__truncated = count
					break
				end
				out[tostring(k)] = ser(v, depth - 1, seen)
				written += 1
			end
		end

		seen[value] = nil
		return out
	end

	return string.format("<%s: %s>", t, tostring(value))
end

------------------------------------------------------------
-- Moon Animator 2 status snapshot (read-only).

local function moonReport()
	local report = { bridge = BRIDGE_VERSION, place = game.Name }

	local g = _G.MoonGlobal
	report.hasMoonGlobal = g ~= nil
	if not g then
		return report
	end

	report.moonVersion = g.ver
	report.moonReady = g.ready == true

	local win = g.Windows and g.Windows.MoonAnimator
	report.hasMainWindow = win ~= nil
	if not win then
		return report
	end

	report.windowVisible = win.Visible == true
	report.hasDoCompositeAction = type(win.DoCompositeAction) == "function"

	local layerSystem = win.g_e and win.g_e.LayerSystem
	report.hasLayerSystem = layerSystem ~= nil
	if not layerSystem then
		return report
	end

	report.fileOpen = layerSystem.CurrentFile ~= nil
	if not layerSystem.CurrentFile then
		return report
	end

	local ok, err = pcall(function()
		report.file = {
			name = layerSystem.CurrentFile.Name,
			fps = layerSystem.FPS,
			length = layerSystem.length,
			frame = layerSystem.SliderFrame,
			loop = layerSystem.PlaybackHandler.Loop,
			rigOnly = layerSystem.RigOnlyMode,
		}

		local items = {}
		for index, container in ipairs(layerSystem.LayerHandler.LayerContainer.Objects) do
			local itemObject = container.ItemObject
			local entry = {
				index = index,
				itemType = itemObject.Path.ItemType,
				path = table.concat(itemObject.Path.InstanceNames, "."),
				hasMarkerTrack = itemObject.MarkerTrack ~= nil,
				properties = {},
			}
			for property, track in pairs(itemObject.PropertyMap) do
				entry.properties[property] = track.TrackItems.size
			end
			if itemObject.RigContainer then
				local joints, keyed = 0, 0
				for _, track in pairs(itemObject.RigMap) do
					joints += 1
					if track.TrackItems.size > 0 then
						keyed += 1
					end
				end
				entry.rig = { joints = joints, keyedJoints = keyed }
			end
			table.insert(items, entry)
		end
		report.items = items
	end)
	if not ok then
		report.fileError = tostring(err)
	end

	return report
end

------------------------------------------------------------
-- Code execution (dev channel). Code receives the helpers table as `...`.

local helpers = { ser = ser, report = moonReport }
local execMode = nil

local function compile(code)
	local wrapped = "return function(...)\n" .. code .. "\nend"

	if execMode ~= "module" then
		local ok, fn, compileError = pcall(loadstring, wrapped, "=MoonBridgeExec")
		if ok and fn then
			execMode = "loadstring"
			return fn()
		elseif ok then
			return nil, "compile error: " .. tostring(compileError)
		end
	end

	local module = Instance.new("ModuleScript")
	module.Name = "MoonBridgeExec"
	module.Source = wrapped
	local ok, result = pcall(require, module)
	module:Destroy()
	if not ok then
		return nil, "compile error: " .. tostring(result)
	end
	execMode = "module"
	return result
end

local function exec(code)
	local fn, compileError = compile(code)
	if not fn then
		return { ok = false, error = compileError }
	end

	local packed = table.pack(xpcall(fn, function(message)
		return debug.traceback(tostring(message), 2)
	end, helpers))
	if not packed[1] then
		return { ok = false, error = tostring(packed[2]), mode = execMode }
	end

	local values = {}
	for i = 2, packed.n do
		local item = ser(packed[i])
		values[i - 1] = if item == nil then "<nil>" else item
	end
	return { ok = true, values = values, mode = execMode }
end

local function execWithTimeout(code, timeout)
	local done, result = false, nil
	task.spawn(function()
		result = exec(code)
		done = true
	end)

	local started = os.clock()
	while not done and os.clock() - started < timeout do
		task.wait()
	end
	if not done then
		return { ok = false, error = string.format("timed out after %ds", timeout) }
	end
	return result
end

------------------------------------------------------------
-- HTTP transport.

local function request(method, path, body)
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = BASE_URL .. path,
			Method = method,
			Headers = {
				["Content-Type"] = "application/json",
				["X-Moon-Token"] = TOKEN,
				["X-Moon-Bridge"] = BRIDGE_VERSION,
			},
			Body = if body then HttpService:JSONEncode(body) else nil,
		})
	end)
	if not ok then
		return nil, tostring(response)
	end
	if not response.Success then
		return nil, string.format("HTTP %d", response.StatusCode)
	end

	local decodedOk, decoded = pcall(HttpService.JSONDecode, HttpService, response.Body)
	if not decodedOk or type(decoded) ~= "table" then
		return nil, "invalid JSON from daemon"
	end
	return decoded
end

local function postResult(id, result)
	local _, err = request("POST", "/result", { id = id, result = result })
	if err then
		-- The result itself may not be encodable; report that instead of hanging the caller.
		request("POST", "/result", { id = id, result = { ok = false, error = "result delivery failed: " .. err } })
	end
end

task.spawn(function()
	local connected = false
	local lastError = nil

	while not unloading do
		local command, err = request("GET", "/poll")

		if command then
			if not connected then
				connected = true
				lastError = nil
				print(string.format("[MoonBridge] connected to daemon on port %d", PORT))
			end

			if command.token == TOKEN and command.id and command.type == "exec" then
				local timeout = tonumber(command.timeout) or DEFAULT_EXEC_TIMEOUT
				postResult(command.id, execWithTimeout(command.code, timeout))
			end
		else
			if connected then
				connected = false
				print("[MoonBridge] daemon disconnected")
			end
			if err ~= lastError then
				lastError = err
				print("[MoonBridge] waiting for daemon: " .. tostring(err))
			end
			task.wait(RETRY_SECONDS)
		end
	end
end)

print(string.format("[MoonBridge] v%s loaded (MoonGlobal visible: %s)", BRIDGE_VERSION, tostring(_G.MoonGlobal ~= nil)))

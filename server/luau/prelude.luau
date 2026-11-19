local H = ...
local HttpService = game:GetService("HttpService")
local Moon = _G.MoonGlobal
if not Moon or not Moon.ready then
	error("MOON: Moon Animator 2 is not loaded in this Studio session", 0)
end
local Win = Moon.Windows.MoonAnimator
local LS = Win.g_e.LayerSystem

local function requireFile()
	if not LS.CurrentFile then
		error("MOON: no Moon Animator file is open; open one in the Moon Animator window first", 0)
	end
end

local function round(n)
	return math.floor(n * 1000 + 0.5) / 1000
end

-- "Back/Out(overshoot=2.5)": type, direction, and any extra parameters that were set.
local function easeLabel(ease)
	if not ease then
		return "Linear"
	end
	local label = ease.ease_type
	local params = ease.params
	if not params then
		return label
	end
	if params.Direction then
		label ..= "/" .. params.Direction
	end
	local extras = {}
	for _, name in ipairs({ "Overshoot", "Amplitude", "Period" }) do
		if type(params[name]) == "number" then
			table.insert(extras, string.lower(name) .. "=" .. tostring(round(params[name])))
		end
	end
	return if #extras > 0 then label .. "(" .. table.concat(extras, ",") .. ")" else label
end

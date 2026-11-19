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

local function easeLabel(ease)
	if not ease then
		return "Linear"
	end
	local direction = ease.params and ease.params.Direction
	return if direction then ease.ease_type .. "/" .. direction else ease.ease_type
end

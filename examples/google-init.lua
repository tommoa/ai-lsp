-- Example Neovim LSP init_options for ai-lsp using Google model
-- Paste this into your Neovim setup to use the `google` provider and
-- the `gemini-flash-latest` model.
-- Note: the LSP server will try to resolve models.dev metadata and
-- create a provider selector. If you prefer a deterministic setup,
-- you can set `providerModule` to a known SDK package.

local M = {}
M.configs = {}

M.configs['ai-lsp'] = {
  on_attach = function() end,
  capabilities = {},
  init_options = {
    providers = {
      google = {
        -- Optional: provide an explicit provider module (if you have one)
        -- providerModule = "@ai-sdk/google" ,
        -- Optional: apiKey (if provider SDK expects it)
        -- apiKey = "YOUR_GOOGLE_API_KEY"
      },
    },
    model = "google/gemini-flash-latest",
  },
  cmd = { 'ai-lsp', '--stdio' },
}

-- Register and enable LSP as in your config
for server, config in pairs(M.configs) do
  vim.lsp.config(server, config)
  vim.lsp.enable(server)
end

return M

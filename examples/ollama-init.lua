-- Example Neovim LSP init_options for ai-lsp using Ollama
-- Make sure Ollama is running: `ollama serve`
-- Pull a model: `ollama pull codegemma`

local M = {}
M.configs = {}

M.configs['ai-lsp'] = {
  on_attach = function() end,
  capabilities = {},
  init_options = {
    providers = {
      ollama = {
        -- Optional: override if using non-default port
        -- baseURL = "http://localhost:11434/v1",
        -- Ollama doesn't require an API key by default
        -- apiKey = "",
      },
    },
    model = "ollama/codegemma",

    -- Use FIM for efficient inline completions with local models
    inline_completion = {
      prompt = "fim",
    },

    -- next_edit can use the same model or a different one
    next_edit = {
      prompt = "prefix_suffix",
    },
  },
  cmd = { 'bun', 'run', '/path/to/ai-lsp/index.ts', '--stdio' },
}

for server, config in pairs(M.configs) do
  vim.lsp.config(server, config)
  vim.lsp.enable(server)
end

return M

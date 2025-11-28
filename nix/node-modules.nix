{ lib, stdenvNoCC, bun, cacert }:
args:
stdenvNoCC.mkDerivation {
  pname = "ai-lsp-node_modules";
  version = args.version;
  src = args.src;

  impureEnvVars =
    lib.fetchers.proxyImpureEnvVars
    ++ [
      "GIT_PROXY_COMMAND"
      "SOCKS_SERVER"
    ];

  nativeBuildInputs = [ bun cacert ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    export HOME=$(mktemp -d)
    export BUN_INSTALL_CACHE_DIR=$(mktemp -d)
    bun install \
      --frozen-lockfile \
      --ignore-scripts \
      --no-progress
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r node_modules $out/
    runHook postInstall
  '';

  # Skip fixup phase to preserve Bun's node_modules structure
  dontFixup = true;

  outputHashAlgo = "sha256";
  outputHashMode = "recursive";
  outputHash = args.hash;
}

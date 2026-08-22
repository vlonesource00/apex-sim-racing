param(
  [ValidateSet('benchmark', 'train', 'evaluate')]
  [string]$Task = 'benchmark'
)

$workspacePath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wslWorkspace = (& wsl.exe -d Ubuntu -u root -- wslpath -a $workspacePath).Trim()
if ($LASTEXITCODE -ne 0 -or -not $wslWorkspace) { throw 'Unable to resolve the project inside WSL.' }
$safeWorkspace = $wslWorkspace.Replace("'", "'\"'\"'")
$python = '/opt/apex73-jax/bin/python'
$command = switch ($Task) {
  'benchmark' { "$python rl/benchmark.py --envs 4096 --steps 2000" }
  'train' { "$python rl/train_ppo.py --envs 512 --horizon 128 --updates 128 --epochs 4 --output rl/artifacts/stage1_gpu_candidate.json" }
  'evaluate' { "$python rl/evaluate_policy.py rl/policies/stage1_policy_compact.json --envs 4096 --steps 1000" }
}
& wsl.exe -d Ubuntu -u root -- bash -lc "cd '$safeWorkspace' && $command"
exit $LASTEXITCODE

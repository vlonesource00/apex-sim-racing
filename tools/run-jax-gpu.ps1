param(
  [ValidateSet('benchmark', 'train', 'evaluate', 'multi-train', 'multi-evaluate')]
  [string]$Task = 'benchmark'
)

$workspacePath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wslWorkspace = (& wsl.exe -d Ubuntu -u root -- wslpath -a $workspacePath).Trim()
if ($LASTEXITCODE -ne 0 -or -not $wslWorkspace) { throw 'Unable to resolve the project inside WSL.' }
$safeWorkspace = $wslWorkspace.Replace("'", "'\''")
$python = '/opt/apex73-jax/bin/python'
$command = switch ($Task) {
  'benchmark' { "$python rl/benchmark.py --envs 4096 --steps 2000" }
  'train' { "$python rl/train_ppo.py --envs 512 --horizon 128 --updates 128 --epochs 4 --output rl/artifacts/stage1_gpu_candidate.json" }
  'evaluate' { "$python rl/evaluate_policy.py rl/policies/stage1_policy_compact.json --envs 4096 --steps 1000" }
  'multi-train' { "$python rl/train_multiagent_ppo.py --envs 1024 --horizon 128 --updates 192 --epochs 4 --output rl/policies/stage2_multiagent_policy.json" }
  'multi-evaluate' { "$python rl/evaluate_multiagent.py rl/policies/stage2_multiagent_policy.json --envs 4096 --steps 700" }
}
& wsl.exe -d Ubuntu -u root -- bash -lc "cd '$safeWorkspace' && $command"
exit $LASTEXITCODE

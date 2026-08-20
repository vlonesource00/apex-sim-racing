export const NUM_INPUTS = 16;
export const NUM_HIDDEN_1 = 32;
export const NUM_HIDDEN_2 = 32;
export const NUM_OUTPUTS = 3;

export const NUM_WEIGHTS = 
  (NUM_INPUTS * NUM_HIDDEN_1 + NUM_HIDDEN_1) +
  (NUM_HIDDEN_1 * NUM_HIDDEN_2 + NUM_HIDDEN_2) +
  (NUM_HIDDEN_2 * NUM_OUTPUTS + NUM_OUTPUTS);

export function createPolicy() {
  const p = new Float32Array(NUM_WEIGHTS);
  for(let i = 0; i < NUM_WEIGHTS; i++) {
    p[i] = (Math.random() - 0.5) * 0.5; // init with small random weights
  }
  return p;
}

export function loadWeights(policy, jsonString) {
  const data = JSON.parse(jsonString);
  for (let i = 0; i < NUM_WEIGHTS; i++) {
    policy[i] = data[i] || 0;
  }
}

export function saveWeights(policy) {
  return JSON.stringify(Array.from(policy));
}

export function mutatePolicy(policy, mutationRate = 0.1, mutationScale = 0.2) {
  const newPolicy = new Float32Array(NUM_WEIGHTS);
  for (let i = 0; i < NUM_WEIGHTS; i++) {
    newPolicy[i] = policy[i];
    if (Math.random() < mutationRate) {
      newPolicy[i] += (Math.random() * 2 - 1) * mutationScale;
    }
  }
  return newPolicy;
}

export function crossoverPolicy(p1, p2) {
  const newPolicy = new Float32Array(NUM_WEIGHTS);
  for (let i = 0; i < NUM_WEIGHTS; i++) {
    newPolicy[i] = Math.random() < 0.5 ? p1[i] : p2[i];
  }
  return newPolicy;
}

function relu(x) {
  return x > 0 ? x : x * 0.05; // Leaky ReLU
}

const h1 = new Float32Array(NUM_HIDDEN_1);
const h2 = new Float32Array(NUM_HIDDEN_2);
const out = new Float32Array(NUM_OUTPUTS);

export function evaluatePolicy(policy, obs) {
  let wIdx = 0;
  
  // Layer 1
  for (let i = 0; i < NUM_HIDDEN_1; i++) {
    let sum = policy[wIdx++]; // Bias
    for (let j = 0; j < NUM_INPUTS; j++) {
      sum += obs[j] * policy[wIdx++];
    }
    h1[i] = relu(sum);
  }
  
  // Layer 2
  for (let i = 0; i < NUM_HIDDEN_2; i++) {
    let sum = policy[wIdx++]; // Bias
    for (let j = 0; j < NUM_HIDDEN_1; j++) {
      sum += h1[j] * policy[wIdx++];
    }
    h2[i] = relu(sum);
  }
  
  // Output Layer
  for (let i = 0; i < NUM_OUTPUTS; i++) {
    let sum = policy[wIdx++]; // Bias
    for (let j = 0; j < NUM_HIDDEN_2; j++) {
      sum += h2[j] * policy[wIdx++];
    }
    out[i] = sum;
  }
  
  // Steer: [-1, 1], Throttle: [0, 1], Brake: [0, 1]
  const steer = Math.max(-1, Math.min(1, Math.tanh(out[0])));
  const throttle = Math.max(0, Math.min(1, out[1])); // using unbounded above 1, then clamped
  const brake = Math.max(0, Math.min(1, out[2]));

  return { steer, throttle, brake };
}

import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

// =================== Scenarios ===================
let scenarios = {
  light_load: {
    executor: 'constant-vus',
    vus: 10,
    duration: '1m',
    tags: { test_type: 'light_load' },
    env: { QUERY: 'publicationsByPerson' },
  },
  peak_load: {
    executor: 'ramping-vus',
    startVUs: 10,
    stages: [
      { duration: '5m', target: 100 },
      { duration: '30m', target: 100 },
      { duration: '5m', target: 0 },
    ],
    tags: { test_type: 'peak_load' },
    env: { QUERY: 'publicationsByPerson' },
  },
  stress_test: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m', target: 200 },
      { duration: '5m', target: 200 },
      { duration: '2m', target: 0 },
    ],
    tags: { test_type: 'stress_test' },
    env: { QUERY: 'publicationsByPerson' },
  },
  endurance_test: {
    executor: 'constant-vus',
    vus: 50,
    duration: '2h',
    tags: { test_type: 'endurance_test' },
    env: { QUERY: 'publicationsByPerson' },
  },
};

// Filter scenario from env
if (__ENV.K6_SCENARIO) {
  scenarios = { [__ENV.K6_SCENARIO]: scenarios[__ENV.K6_SCENARIO] };
}

export const options = {
  scenarios,
  thresholds: {
    http_req_failed: ['rate<0.05'], // <5% errors
    http_req_duration: ['p(95)<500', 'p(99)<1500'],
  },
};

// =================== Queries ===================
const queries = new SharedArray('graphql-queries', function () {
  const queryFiles = ['publicationsByPerson.graphql', 'keywordSearch.graphql'];
  return queryFiles.map((file) => {
    const queryName = file.replace('.graphql', '');
    const query = open(`./queries/${file}`);
    const variables = JSON.parse(open(`./config/local.json`));
    return { name: queryName, query, variables: variables[queryName] };
  });
});

// =================== Setup ===================
export function setup() {
  const url = 'http://localhost:10000/graphql';

  const authMutation = `
    mutation {
      authenticateUser(input: {
        email: "postman-integration@h1.co",
        password: "pS34^$2bqs",
        projectId: "1",
        app: "MAIN"
      }) {
        token 
      }
    }
  `;

  const res = http.post(
    url,
    JSON.stringify({ query: authMutation }),
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: '1m',
    }
  );

  let token;
  try {
    token = res.json('data.authenticateUser.token');
  } catch (e) {
    console.error(`Auth response parse failed: ${res.body}`);
  }

  if (res.status !== 200 || !token) {
    throw new Error('Authentication failed, could not retrieve token.');
  }

  console.log('✅ Successfully retrieved auth token.');
  return token;
}

// =================== Main Test ===================
export default function (token) {
  const url = 'http://localhost:10000/graphql';

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Cookie': 'refreshToken=b772efe6-26bc-4866-bf70-51faca09fcdb',
    },
    timeout: '30s',
  };

  const queryName = __ENV.QUERY || 'publicationsByPerson';
  const selectedQuery = queries.find((q) => q.name === queryName);

  if (!selectedQuery) {
    console.error(`❌ Query '${queryName}' not found.`);
    return;
  }

  const res = http.post(
    url,
    JSON.stringify({ query: selectedQuery.query, variables: selectedQuery.variables }),
    params
  );

  let hasErrors = false;
  try {
    const body = res.json();
    if (body.errors) {
      hasErrors = true;
      console.error(`GraphQL error: ${JSON.stringify(body.errors)}`);
    }
  } catch (e) {
    console.error(`❌ Failed to parse response: ${e.message}`);
    hasErrors = true;
  }

  check(res, {
    'is status 200': (r) => r.status === 200,
    'response has no errors': () => !hasErrors,
  });

  sleep(1);
}

// =================== Summary ===================
export function handleSummary(data) {
  console.log('📊 Test finished. Generating report...');

  function safe(val) {
    return val !== undefined && val !== null && !isNaN(val)
      ? val.toFixed(2)
      : 'N/A';
  }

  const vusMax = data.metrics.vus_max?.values?.value || 'N/A';
  const iterations = data.metrics.iterations?.values?.count || 'N/A';

  let summary = `
Test Report
===================================
Executed at: ${new Date().toISOString()}

Total VUs: ${vusMax}
Total iterations: ${iterations}

Metrics
-----------------------------------
Failure rate: ${safe(data.metrics.http_req_failed?.values?.rate)}
Duration (p95): ${safe(data.metrics.http_req_duration?.values?.['p(95)'])} ms
Duration (p99): ${safe(data.metrics.http_req_duration?.values?.['p(99)'])} ms
Throughput: ${safe(data.metrics.http_reqs?.values?.rate)} req/s

Bottlenecks & Recommendations
-----------------------------------
- Check Grafana dashboards for CPU, memory, DB saturation.
- Identify slow queries and optimize resolvers.
`;

  console.log(summary);

  return { 'summary.txt': summary };
}
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend, Counter } from 'k6/metrics';

// =================== Custom Metrics ===================
const authDuration = new Trend('auth_duration');
const graphqlResponseTime = new Trend('graphql_response_time');
const graphqlErrorCount = new Counter('graphql_error_count');

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
  // You can uncomment thresholds if needed
  // thresholds: {
  //   http_req_failed: ['rate<0.05'],
  //   http_req_duration: ['p(95)<500', 'p(99)<1500'],
  //   graphql_error_count: ['count<10'],
  // },
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
  const url = 'https://develop-api.h1insights.com/graphql';

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

  authDuration.add(res.timings.duration);

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
  const url = 'https://develop-api.h1insights.com/graphql';

  const queryName = __ENV.QUERY || 'publicationsByPerson';
  const selectedQuery = queries.find((q) => q.name === queryName);

  if (!selectedQuery) {
    console.error(`❌ Query '${queryName}' not found.`);
    return;
  }

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Cookie': 'refreshToken=b772efe6-26bc-4866-bf70-51faca09fcdb',
    },
    timeout: '30s',
    tags: {
      query: selectedQuery.name,
    },
  };

  const res = http.post(
    url,
    JSON.stringify({ query: selectedQuery.query, variables: selectedQuery.variables }),
    params
  );

  // Custom metric: GraphQL response time
  graphqlResponseTime.add(res.timings.duration, { query: selectedQuery.name });

  let hasErrors = false;
  try {
    const body = res.json();
    if (body.errors) {
      hasErrors = true;
      graphqlErrorCount.add(1, { query: selectedQuery.name });
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

  // Convert ms → seconds safely
  function safeSeconds(val) {
    return val !== undefined && val !== null && !isNaN(val)
      ? (val / 1000).toFixed(2)
      : 'N/A';
  }

  const m = data.metrics;

  let summary = `
Test Report
===================================
Executed at: ${new Date().toISOString()}

Total VUs: ${m.vus_max?.values?.value || 'N/A'}
Total iterations: ${m.iterations?.values?.count || 'N/A'}

High-level Metrics
-----------------------------------
Failure rate: ${m.http_req_failed?.values?.rate?.toFixed(4) || 'N/A'}
Requests per second: ${m.http_reqs?.values?.rate?.toFixed(2) || 'N/A'}
Total requests: ${m.http_reqs?.values?.count || 'N/A'}
Duration (avg): ${safeSeconds(m.http_req_duration?.values?.avg)} s
Duration (p95): ${safeSeconds(m.http_req_duration?.values?.['p(95)'])} s
Duration (p90): ${safeSeconds(m.http_req_duration?.values?.['p(90)'])} s

Custom Metrics
-----------------------------------
Auth Duration (p95): ${safeSeconds(m.auth_duration?.values?.['p(95)'])} s
GraphQL Errors: ${m.graphql_error_count?.values?.count || 0}

Detailed HTTP Timings (avg)
-----------------------------------
DNS lookup: ${safeSeconds(m.http_req_blocked?.values?.avg)} s
TCP connect: ${safeSeconds(m.http_req_connecting?.values?.avg)} s
TLS handshake: ${safeSeconds(m.http_req_tls_handshaking?.values?.avg)} s
TTFB (waiting): ${safeSeconds(m.http_req_waiting?.values?.avg)} s
Sending: ${safeSeconds(m.http_req_sending?.values?.avg)} s
Receiving: ${safeSeconds(m.http_req_receiving?.values?.avg)} s

Data Transfer
-----------------------------------
Data sent: ${(m.data_sent?.values?.count || 0).toFixed(0)} bytes
Data received: ${(m.data_received?.values?.count || 0).toFixed(0)} bytes

Iteration Durations
-----------------------------------
Avg: ${safeSeconds(m.iteration_duration?.values?.avg)} s
p95: ${safeSeconds(m.iteration_duration?.values?.['p(95)'])} s
p90: ${safeSeconds(m.iteration_duration?.values?.['p(90)'])} s

GraphQL Response Times (p95 per query)
-----------------------------------
`;

  // Add per-query GraphQL response times in seconds
  for (const queryName of queries.map((q) => q.name)) {
    const metricName = `graphql_response_time{query=${queryName}}`;
    const metric = data.metrics[metricName];
    if (metric) {
      summary += `${queryName}: ${safeSeconds(metric.values['p(95)'])} s\n`;
    }
  }

  console.log(summary);

  return {
    'summary.txt': summary,
    'summary.json': JSON.stringify(data, null, 2),
  };
}

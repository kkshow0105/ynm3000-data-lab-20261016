# Temporary synthetic JSON experiment

No real market data, credentials, external market requests or Netlify connection.

The scheduled workflow updates test.json, at most three times. Intentional failure mode leaves the last valid JSON unchanged. Workflow will be disabled after the experiment.

The schedule uses UTC. Raw delivery may lag behind a successful commit.

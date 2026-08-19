#!/bin/sh
set -eu
git status --short
git remote -v
git config user.name 'Player Brief Rollout'
git config user.email '98953892+karkandea@users.noreply.github.com'
git add package-lock.json
git commit -m 'chore: regenerate package lock with npm'
git push origin HEAD:agent/player-brief-production-complete

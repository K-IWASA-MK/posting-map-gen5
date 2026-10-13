import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function runStep(description, command) {
  console.log(`\n🚀 [Safe Deploy Step] ${description}...`);
  try {
    const output = execSync(command, { encoding: 'utf8' });
    console.log(output);
    return output;
  } catch (error) {
    console.error(`\n🛑 [Hard Stop] ${description} failed.`);
    if (error.stdout) console.error(error.stdout.toString());
    if (error.stderr) console.error(error.stderr.toString());
    process.exit(1);
  }
}

function getSSOTDeploymentInfo() {
  const deploymentJsonPath = resolve(process.cwd(), 'deployment.json');
  try {
    const data = JSON.parse(readFileSync(deploymentJsonPath, 'utf8'));
    const deploymentId = data.deploymentId || (data.resources && data.resources.deploymentId);
    const webAppUrl = data.webAppUrl || (data.resources && data.resources.webAppUrl);
    if (!deploymentId) {
      throw new Error('deploymentId is missing in deployment.json');
    }
    return { deploymentId, webAppUrl };
  } catch (err) {
    console.error(`\n🛑 [Hard Stop] Failed to read deployment.json: ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  console.log('====================================================');
  console.log('🚀 GAS PRODUCTION DEPLOYMENT & VERIFICATION GATE');
  console.log('====================================================');

  const uncommitted = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
  if (uncommitted.length > 0) {
    console.error('\n🛑 [Hard Stop] Working tree is dirty. Deploy requires a clean working tree.\n' + uncommitted);
    process.exit(1);
  }
  runStep('Preflight Scope & Governance Gate', 'node scripts/check-scope.mjs');
  runStep('Preflight District Data Quality Gate', 'node scripts/validate-district-data-gate.mjs');
  // Step 1: Preflight SSOT Check
  runStep('Step 1: Preflight SSOT Check', 'npm run check:ssot');

  console.log('\n🚀 [Safe Deploy Step] Step 1.5: GAS Version Quota Preflight Gate...');
  try {
    const versionsRaw = execSync('npx clasp list-versions', { encoding: 'utf8' });
    const versionLines = versionsRaw.trim().split('\n').filter(line => /^\d+\s*-/.test(line));
    const versionCount = versionLines.length;
    console.log(`📊 Current GAS Version Count: ${versionCount} / 200`);

    if (versionCount >= 190) {
      console.error(`\n🛑 [Hard Stop] GAS Version Limit Critical! (${versionCount}/200)`);
      console.error('   Creating a new version would risk exceeding the hard limit of 200 versions.');
      console.error('   Please manually clean up unused versions in Apps Script Project History before deploying.');
      process.exit(1);
    } else if (versionCount >= 170) {
      console.warn(`\n⚠️  [WARNING] GAS Version Count is High: ${versionCount} / 200.`);
      console.warn('   Please plan to clean up unused versions via Apps Script Project History soon.\n');
    } else {
      console.log(`✅ [Version Gate Normal] Ample version slots available (${200 - versionCount} slots remaining).`);
    }
  } catch (err) {
    console.warn(`⚠️  [Version Gate Warning] Failed to inspect version list: ${err.message}. Proceeding with caution.`);
  }

  console.log('\n🚀 [Safe Deploy Step] Step 2: Source Code Sync (clasp push)...');
  const pushOutput = runStep('Syncing local files to GAS HEAD', 'npx clasp push');
  const pushSuccess = pushOutput.includes('Pushed') || pushOutput.includes('already up to date');
  if (!pushSuccess) {
    console.error('🛑 [Hard Stop] clasp push did not report successful file push.');
    process.exit(1);
  }

  // Step 3: Execute clasp deploy with fixed Deployment ID
  const { deploymentId, webAppUrl } = getSSOTDeploymentInfo();
  console.log(`\n📌 Target SSOT Deployment ID: ${deploymentId}`);
  
  let gitCommitSha = '';
  try {
    gitCommitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch (e) {
    gitCommitSha = 'manual';
  }
  const deployDesc = `Production Release (${gitCommitSha} - ${new Date().toISOString().substring(0, 19).replace('T', ' ')})`;

  console.log(`\n🚀 [Safe Deploy Step] Step 3: Executing clasp deploy (Creating new version)...`);
  const deployOutput = runStep(
    'Creating production version and updating deployment',
    `npx clasp deploy -i ${deploymentId} -d "${deployDesc}"`
  );

  // Extract created version number from deploy stdout (e.g. "Deployed AKfycby... @158")
  const createdVersionMatch = deployOutput.match(/@(\d+)/);
  if (!createdVersionMatch) {
    console.error(`\n🛑 [Hard Stop] Could not determine created version from clasp deploy output: ${deployOutput}`);
    process.exit(1);
  }
  const createdVersion = createdVersionMatch[1];
  console.log(`\n✨ Created New Deployment Version: @${createdVersion}`);

  // Step 4: Deployment Version Gate (Audit active deployments)
  console.log(`\n🚀 [Safe Deploy Step] Step 4: Deployment Version Gate (Audit active deployments)...`);
  const deploymentsOutput = execSync('npx clasp deployments', { encoding: 'utf8' });
  console.log(deploymentsOutput);

  // Parse lines to find target deploymentId
  const deploymentLines = deploymentsOutput.split('\n');
  let activeVersion = null;
  for (const line of deploymentLines) {
    if (line.includes(deploymentId)) {
      const match = line.match(/@(\d+)/);
      if (match) {
        activeVersion = match[1];
        break;
      }
    }
  }

  console.log(`\n🔍 [Version Gate Audit]`);
  console.log(`  - Target Deployment ID:      ${deploymentId}`);
  console.log(`  - Created Version (Step 3):  @${createdVersion}`);
  console.log(`  - Active Version (clasp):    @${activeVersion}`);

  if (!activeVersion) {
    console.error(`\n🛑 [Hard Stop] Target deployment ID (${deploymentId}) was not found in 'clasp deployments' output.`);
    process.exit(1);
  }

  if (activeVersion !== createdVersion) {
    console.error(`\n🛑 [Hard Stop] DEPLOYMENT VERSION MISMATCH!`);
    console.error(`   Created Version: @${createdVersion} !== Active Version: @${activeVersion}`);
    console.error(`   Production Web App is NOT serving the latest code.`);
    process.exit(1);
  }
  console.log(`✅ [Version Gate PASSED] Active Deployment Version matches created version: @${activeVersion}`);

  // Step 5: Post-deploy Endpoint Verification
  console.log(`\n🚀 [Safe Deploy Step] Step 5: Production Endpoint Verification...`);
  runStep('Production Endpoint Verification Suite', 'npm run verify:gas');

  console.log('\n====================================================');
  console.log(`🎉 [PRODUCTION DEPLOYMENT SUCCESS]`);
  console.log(`   Deployment ID:   ${deploymentId}`);
  console.log(`   Active Version:  @${activeVersion}`);
  console.log(`   Endpoint:        ${webAppUrl || `https://script.google.com/macros/s/${deploymentId}/exec`}`);
  console.log('====================================================\n');
}

main();

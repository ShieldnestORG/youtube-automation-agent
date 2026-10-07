require('dotenv').config();
const chalk = require('chalk');
const { Database } = require('./database/db');
const { CredentialManager } = require('./utils/credential-manager');
const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
const { ScriptWriterAgent } = require('./agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('./agents/production-management-agent');
const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');

async function generateNow() {
  console.log(chalk.cyan.bold('\n🎬 Manual Video Generation'));
  console.log(chalk.gray('─'.repeat(50)));

  const db = new Database();
  await db.initialize();

  const credentials = new CredentialManager();
  await credentials.validateAll();

  const agents = {
    strategy:   new ContentStrategyAgent(db, credentials),
    scriptWriter: new ScriptWriterAgent(db, credentials),
    thumbnail:  new ThumbnailDesignerAgent(db, credentials),
    seo:        new SEOOptimizerAgent(db, credentials),
    production: new ProductionManagementAgent(db, credentials),
    publishing: new PublishingSchedulingAgent(db, credentials),
  };

  for (const [name, agent] of Object.entries(agents)) {
    await agent.initialize();
    console.log(chalk.gray(`  ✓ ${name}`));
  }

  console.log(chalk.cyan('\n📋 Step 1/6: Generating content strategy...'));
  const strategy = await agents.strategy.generateContentStrategy();
  console.log(chalk.green(`  Topic: ${strategy.topic}`));
  console.log(chalk.green(`  Angle: ${strategy.angle}`));
  console.log(chalk.green(`  Type:  ${strategy.contentType}`));

  console.log(chalk.cyan('\n✍️  Step 2/6: Writing AI script...'));
  const script = await agents.scriptWriter.generateScript(strategy);
  console.log(chalk.green(`  Title: ${script.title}`));
  console.log(chalk.green(`  Duration: ${script.duration}`));
  console.log(chalk.green(`  Version: ${script.metadata?.version}`));

  console.log(chalk.cyan('\n🖼️  Step 3/6: Generating thumbnail...'));
  const thumbnail = await agents.thumbnail.generateThumbnail(script);
  console.log(chalk.green(`  Thumbnail ready`));

  console.log(chalk.cyan('\n🔍 Step 4/6: SEO optimization...'));
  const seoData = await agents.seo.optimize(script, strategy);
  console.log(chalk.green(`  Tags: ${(seoData.tags || []).slice(0, 5).join(', ')}...`));

  console.log(chalk.cyan('\n🎞️  Step 5/6: Production processing...'));
  const productionData = await agents.production.processContent({ strategy, script, thumbnail, seo: seoData });
  console.log(chalk.green(`  Production ID: ${productionData.id}`));

  console.log(chalk.cyan('\n📅 Step 6/6: Scheduling for publish...'));
  await agents.publishing.scheduleContent(productionData);

  console.log(chalk.green.bold('\n✅ Video generation complete!'));
  console.log(chalk.white(`  Title:        ${script.title}`));
  console.log(chalk.white(`  Content ID:   ${productionData.id}`));
  console.log(chalk.white(`  Scheduled:    ${productionData.scheduledPublishTime}`));
  console.log(chalk.gray('\nRun "npm start" to manage publishing from the dashboard.\n'));

  process.exit(0);
}

generateNow().catch(err => {
  console.error(chalk.red('\n❌ Generation failed:'), err.message);
  console.error(err.stack);
  process.exit(1);
});

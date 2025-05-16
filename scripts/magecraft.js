// Main module code for Magecraft ability score
import { libWrapper } from '../lib/libWrapper/shim.js';

/**
 * The main initialization hook that sets up all the necessary configurations
 * for the Magecraft ability score to function identically to built-in abilities.
 */
Hooks.once('init', () => {
  console.log('Magecraft Ability | Initializing Magecraft Ability Score Module');
  
  // Register the new ability score in the core config
  CONFIG.DND5E.abilities.mgc = {
    label: "Magecraft",
    abbreviation: "mgc",
    fullKey: "mgc",
    icon: "fas fa-hat-wizard", // Custom icon
    defaults: { value: 10, min: 3, max: 20 } // Default values like other abilities
  };
  
  // Register the ability abbreviation for saving throws
  CONFIG.DND5E.abilityAbbreviations.mgc = "mgc";
  
  // Add to consumptionTargets for item targeting
  if (CONFIG.DND5E.abilityConsumptionTargets) {
    CONFIG.DND5E.abilityConsumptionTargets.push({
      value: "mgc",
      label: "DND5E.AbilityMgc"
    });
  }
  
  // Register for ability base modifiers
  if (CONFIG.DND5E.characterFlags) {
    CONFIG.DND5E.characterFlags.magecraftSaveProficiency = {
      name: "Magecraft Save Proficiency",
      hint: "Proficiency in Magecraft saving throws.",
      section: "Proficiencies",
      type: Boolean
    };
  }
  
  // Register i18n strings
  game.i18n.translations.DND5E = foundry.utils.mergeObject(game.i18n.translations.DND5E || {}, {
    "AbilityMgc": "Magecraft",
    "AbilityMgcAbbr": "mgc"
  });
  
  // Add Magecraft to the list of abilities in various actor templates
  Hooks.on('dnd5e.preCreateActor', (actorData, options, userId) => {
    // Make sure new actors have our Magecraft ability
    if (!actorData.system?.abilities?.mgc && ["character", "npc"].includes(actorData.type)) {
      mergeObject(actorData, {
        "system.abilities.mgc": {
          value: 10,
          proficient: 0,
          mod: 0,
          save: 0,
          prof: 0,
          bonuses: {
            check: "",
            save: ""
          },
          min: 3,
          max: 20
        }
      });
    }
  });
  
  // Register for hooks to handle the Active Effects system
  Hooks.once('setup', () => {
    // Register valid paths for Active Effects 
    const abilities = CONFIG.DND5E.abilities;
    const paths = [];
    
    // Add paths for all abilities attributes
    for (const [ability, attr] of Object.entries(abilities)) {
      if (ability === "mgc") {
        paths.push(
          `system.abilities.mgc.value`, 
          `system.abilities.mgc.proficient`,
          `system.abilities.mgc.bonuses.check`,
          `system.abilities.mgc.bonuses.save`
        );
      }
    }
    
    // Add to the effect targets
    if (game.dnd5e.config && game.dnd5e.config.activeEffectTargets) {
      game.dnd5e.config.activeEffectTargets = paths.concat(game.dnd5e.config.activeEffectTargets || []);
    }
  });
  
  // Listen for hooks to render the character sheet
  libWrapper.register(
    'magecraft-ability',
    'dnd5e.applications.actor.ActorSheet5eCharacter.prototype._renderInner',
    _injectMagecraftUI,
    'WRAPPER'
  );
  
  // Register hooks related to actor updates and derived data
  Hooks.on('dnd5e.preUpdateActor', _validateMagecraftUpdate);
  Hooks.on('dnd5e.prepareDerivedData', _prepareDerivedMagecraftData);
  
  // Register for ability score improvements
  Hooks.on('dnd5e.preItemUsageConsumption', _handleMagecraftConsumption);
  
  // Handle existing actors when module is first enabled
  Hooks.on('ready', () => {
    for (let actor of game.actors) {
      if ((actor.type === 'character' || actor.type === 'npc') && !actor.system.abilities.mgc) {
        _addMagecraftToActor(actor);
      }
    }
    
    // Patch Actor5e class methods to handle Magecraft
    patchActorClass();
    
    // Patch advancement system for ASIs
    patchAdvancementSystem();
  });
});

/**
 * Patches the advancement system to support Magecraft for ability score improvements
 */
function patchAdvancementSystem() {
  // Add Magecraft to ability score improvements
  if (game.dnd5e.applications && game.dnd5e.applications.advancement) {
    const ASIConfig = game.dnd5e.applications.advancement.AbilityScoreImprovementConfig;
    if (ASIConfig && ASIConfig.prototype) {
      const originalGetData = ASIConfig.prototype.getData;
      ASIConfig.prototype.getData = async function() {
        const data = await originalGetData.call(this);
        // Add Magecraft to the ability list
        data.abilities.mgc = CONFIG.DND5E.abilities.mgc;
        return data;
      };
    }
  }
}

/**
 * Validates Magecraft updates to ensure they follow ability score rules
 */
function _validateMagecraftUpdate(actor, update, options, userId) {
  // Check if we're updating the Magecraft value
  if (foundry.utils.hasProperty(update, "system.abilities.mgc.value")) {
    const newValue = update.system.abilities.mgc.value;
    const min = actor.system.abilities.mgc.min || 3;
    const max = actor.system.abilities.mgc.max || 20;
    
    // Enforce min/max boundaries
    if (newValue < min) update.system.abilities.mgc.value = min;
    if (newValue > max) update.system.abilities.mgc.value = max;
  }
}

/**
 * Prepares derived data for Magecraft, just like standard abilities
 */
function _prepareDerivedMagecraftData(actor) {
  if (!actor.system.abilities.mgc) return;
  
  const mgc = actor.system.abilities.mgc;
  
  // Calculate ability modifier
  mgc.mod = Math.floor((mgc.value - 10) / 2);
  
  // Calculate saving throw modifier
  const proficient = Number(mgc.proficient || 0);
  mgc.save = mgc.mod + (actor.system.attributes.prof * proficient);
  
  // Calculate passive check value
  mgc.passive = 10 + mgc.mod;
  
  // Calculate MP resource if it's a character
  if (actor.type === "character") {
    // Create MP resource if it doesn't exist
    if (!actor.system.resources.mp) {
      actor.system.resources.mp = {
        value: 0,
        max: 0,
        sr: 0,
        lr: 1, // Recovers on long rest like standard resources
        label: "Mana Points"
      };
    }
    
    // Calculate MP based on Magecraft
    const mpValue = calculateMP(actor);
    actor.system.resources.mp.max = mpValue;
    
    // Initialize MP value to max if it's zero or undefined
    if (!actor.system.resources.mp.value) {
      actor.system.resources.mp.value = mpValue;
    }
  }
}

/**
 * Handles Magecraft targeting in item consumption
 */
function _handleMagecraftConsumption(item, config, options) {
  // Check if this consumption targets Magecraft
  if (config.type === "ability" && config.target === "mgc") {
    // Handle consumption like standard abilities
    const actor = item.actor;
    if (actor && actor.system.abilities.mgc) {
      // Process ability based consumptions
    }
  }
}

/**
 * Patches the Actor5e class to handle Magecraft ability rolls
 */
function patchActorClass() {
  // Extend the rollAbility method to handle 'mgc'
  const originalRollAbility = game.dnd5e.documents.Actor5e.prototype.rollAbility;
  game.dnd5e.documents.Actor5e.prototype.rollAbility = function(abilityId, options={}) {
    // If it's a standard ability, use the original method
    if (abilityId !== 'mgc') {
      return originalRollAbility.call(this, abilityId, options);
    }
    
    // Handle Magecraft ability
    const ability = this.system.abilities.mgc;
    const label = game.i18n.format("DND5E.AbilityPromptTitle", {ability: "Magecraft"});
    const parts = ["@mod"];
    const data = {mod: ability.mod};
    
    // Create the dialog for ability check or saving throw
    if (!options.parts) options.parts = [];
    options.parts = parts.concat(options.parts);
    
    // Create Dialog options
    const rollOptions = {
      actor: this,
      data,
      title: label,
      flavor: null,
      speaker: ChatMessage.getSpeaker({actor: this}),
      dialogOptions: {
        width: 400,
        top: options.event ? options.event.clientY - 80 : null,
        left: options.event ? options.event.clientX + 80 : null
      },
      chooseModifier: false,
      halflingLucky: this.getFlag("dnd5e", "halflingLucky"),
      reliableTalent: false,
      messageData: {"flags.dnd5e.roll": {type: "ability", abilityId }}
    };
    
    // Create dialog offering ability check vs saving throw options
    const buttons = {
      test: {
        label: game.i18n.localize("DND5E.ActionAbil"),
        callback: () => this.rollAbilityTest("mgc", options)
      }
    };
    if (ability.proficient) {
      buttons.save = {
        label: game.i18n.localize("DND5E.ActionSave"),
        callback: () => this.rollAbilitySave("mgc", options)
      };
    }
    
    // Show dialog if there are multiple options or we always show the dialog
    if (Object.keys(buttons).length > 1) {
      new Dialog({
        title: rollOptions.title,
        content: `<p>${game.i18n.localize("DND5E.AbilityUseHint")}</p>`,
        buttons,
        default: "test",
        close: () => {}
      }, rollOptions.dialogOptions).render(true);
    } else {
      // Otherwise just trigger an ability test
      this.rollAbilityTest("mgc", options);
    }
  };
  
  // Extend the rollAbilityTest method to handle 'mgc'
  const originalRollAbilityTest = game.dnd5e.documents.Actor5e.prototype.rollAbilityTest;
  game.dnd5e.documents.Actor5e.prototype.rollAbilityTest = function(abilityId, options={}) {
    if (abilityId !== 'mgc') {
      return originalRollAbilityTest.call(this, abilityId, options);
    }
    
    const ability = this.system.abilities.mgc;
    const title = game.i18n.format("DND5E.AbilityTest", {ability: "Magecraft"});
    
    // Roll and return
    const parts = ["@mod"];
    const data = {mod: ability.mod};
    
    // Include ability check bonus
    if (ability.bonuses?.check) {
      const checkBonus = ability.bonuses.check;
      parts.push("@checkBonus");
      data.checkBonus = Roll.replaceFormulaData(checkBonus, this.getRollData());
    }
    
    // Global ability check bonus
    if (this.system.bonuses?.abilities?.check) {
      parts.push("@globalCheckBonus");
      data.globalCheckBonus = Roll.replaceFormulaData(this.system.bonuses.abilities.check, this.getRollData());
    }
    
    // Call the standard roll method
    if (!options.parts) options.parts = [];
    options.parts = parts.concat(options.parts);
    
    // Create the Roll instance
    const flavor = options.flavor || title;
    const rollData = mergeObject({
      data,
      title,
      flavor,
      messageData: {
        speaker: options.speaker || ChatMessage.getSpeaker({actor: this}),
        "flags.dnd5e.roll": {type: "ability", abilityId: "mgc"}
      }
    }, options);
    
    // Execute the roll
    return game.dnd5e.dice.d20Roll(rollData);
  };
  
  // Extend the rollAbilitySave method to handle 'mgc'
  const originalRollAbilitySave = game.dnd5e.documents.Actor5e.prototype.rollAbilitySave;
  game.dnd5e.documents.Actor5e.prototype.rollAbilitySave = function(abilityId, options={}) {
    if (abilityId !== 'mgc') {
      return originalRollAbilitySave.call(this, abilityId, options);
    }
    
    const ability = this.system.abilities.mgc;
    const title = game.i18n.format("DND5E.SavePromptTitle", {ability: "Magecraft"});
    
    // Prepare roll data
    const parts = ["@mod", "@prof"];
    const data = {
      mod: ability.mod,
      prof: this.system.attributes.prof * ability.proficient
    };
    
    // Include a situational bonus
    if (ability.bonuses?.save) {
      const saveBonus = ability.bonuses.save;
      parts.push("@saveBonus");
      data.saveBonus = Roll.replaceFormulaData(saveBonus, this.getRollData());
    }
    
    // Include ability-specific saving throw bonus
    if (this.system.bonuses?.abilities?.save) {
      parts.push("@globalSaveBonus");
      data.globalSaveBonus = Roll.replaceFormulaData(this.system.bonuses.abilities.save, this.getRollData());
    }
    
    // Execute the roll
    if (!options.parts) options.parts = [];
    options.parts = parts.concat(options.parts);
    
    const flavor = options.flavor || title;
    const rollData = mergeObject({
      data,
      title,
      flavor,
      messageData: {
        speaker: options.speaker || ChatMessage.getSpeaker({actor: this}),
        "flags.dnd5e.roll": {type: "save", abilityId: "mgc"}
      }
    }, options);
    
    return game.dnd5e.dice.d20Roll(rollData);
  };
  
  // Add to getRollData() so formulas can reference Magecraft
  const originalGetRollData = game.dnd5e.documents.Actor5e.prototype.getRollData;
  game.dnd5e.documents.Actor5e.prototype.getRollData = function() {
    const data = originalGetRollData.call(this);
    
    // Make sure Magecraft is included in the rollData if it exists
    if (this.system.abilities.mgc) {
      if (!data.abilities) data.abilities = {};
      data.abilities.mgc = foundry.utils.deepClone(this.system.abilities.mgc);
    }
    
    return data;
  };
  
  // Modify exportToJSON to include Magecraft in exports
  if (game.dnd5e.applications && game.dnd5e.applications.actor) {
    const ActorExporter = game.dnd5e.applications.actor.ActorExporter;
    if (ActorExporter && ActorExporter.prototype) {
      const originalGetData = ActorExporter.prototype.getData;
      ActorExporter.prototype.getData = async function() {
        const data = await originalGetData.call(this);
        
        // Make sure Magecraft is included in exports
        if (this.actor.system.abilities.mgc) {
          if (data.abilities) {
            data.abilities.mgc = this.actor.system.abilities.mgc.value;
          }
        }
        
        return data;
      };
    }
  }
}

/**
 * Adds the Magecraft ability score to an actor
 */
async function _addMagecraftToActor(actor) {
  // Only add if it doesn't already exist
  if (!actor.system.abilities.mgc) {
    try {
      const updateData = {
        "system.abilities.mgc": {
          value: 10,
          proficient: 0,
          mod: 0,
          save: 0,
          prof: 0,
          bonuses: {
            check: "",
            save: ""
          },
          min: 3,
          max: 20
        }
      };
      
      await actor.update(updateData);
      console.log(`Magecraft Ability | Added Magecraft to ${actor.name}`);
    } catch (error) {
      console.error(`Magecraft Ability | Error adding Magecraft to ${actor.name}:`, error);
    }
  }
}

/**
 * Injects the Magecraft UI into the character sheet
 */
async function _injectMagecraftUI(wrapped, ...args) {
  // Call the original _renderInner method to get the HTML
  const html = await wrapped(...args);
  
  // Find the abilities container
  const abilitiesElement = html.find('.ability-scores');
  
  if (abilitiesElement.length > 0) {
    // Create Magecraft ability UI element
    const actor = this.actor;
    const mgcValue = actor.system.abilities.mgc?.value || 10;
    const mgcMod = actor.system.abilities.mgc?.mod || 0;
    const mgcProficient = actor.system.abilities.mgc?.proficient || 0;
    
    // Create HTML for the new ability score (matching the existing format)
    const mgcHTML = `
      <li class="ability" data-ability="mgc">
        <div class="ability-header">
          <input type="text" name="system.abilities.mgc.value" value="${mgcValue}" placeholder="10" data-dtype="Number">
          <span class="ability-mod" title="Modifier">
            ${mgcMod >= 0 ? '+' + mgcMod : mgcMod}
          </span>
        </div>
        <div class="ability-name">
          <label>Magecraft</label>
        </div>
        <div class="ability-proficiency">
          <input type="checkbox" name="system.abilities.mgc.proficient" ${mgcProficient ? 'checked' : ''} data-dtype="Boolean">
        </div>
      </li>
    `;
    
    // Add the new ability to the list
    abilitiesElement.append(mgcHTML);
    
    // Add click event listeners to the Magecraft ability
    const mgcElement = html.find('.ability[data-ability="mgc"]');
    
    // Make ability header clickable for ability checks (matches core functionality)
    mgcElement.find('.ability-header').click(event => {
      event.preventDefault();
      actor.rollAbility('mgc', {event: event});
    });
    
    // Make ability name clickable for ability checks
    mgcElement.find('.ability-name').click(event => {
      event.preventDefault();
      actor.rollAbility('mgc', {event: event});
    });
    
    // Make proficiency checkbox toggle saving throw proficiency
    mgcElement.find('.ability-proficiency input').change(event => {
      const isChecked = event.currentTarget.checked;
      actor.update({
        'system.abilities.mgc.proficient': isChecked ? 1 : 0
      });
    });
    
    // Add passive score display to character sheet's attributes section if it's a character sheet
    const passivesElement = html.find('.attributes');
    if (passivesElement.length > 0) {
      const passiveScore = actor.system.abilities.mgc?.passive || 10;
      const passiveHtml = `
        <li class="attribute magecraft-passive">
          <h4 class="attribute-name box-title">
            Passive Magecraft
          </h4>
          <div class="attribute-value">
            <span>${passiveScore}</span>
          </div>
        </li>
      `;
      
      // Find the right place to insert
      const passivesInsertTarget = html.find('.attributes .attribute.passive');
      if (passivesInsertTarget.length > 0) {
        // Insert after other passives
        passivesInsertTarget.last().after(passiveHtml);
      } else {
        // Append to attributes section
        passivesElement.find('ul.attributes-list').append(passiveHtml);
      }
    }
    
    // Add mana points to resources if it's a character sheet
    if (actor.type === "character") {
      const resourcesElement = html.find('.resources');
      if (resourcesElement.length > 0) {
        // Calculate MP if it's not already present
        const mpMax = actor.system.resources.mp?.max || calculateMP(actor);
        const mpValue = actor.system.resources.mp?.value || mpMax;
        
        // Insert MP resource into the resources section
        const mpHtml = `
          <li class="resource magecraft-mp">
            <h4 class="resource-name box-title">
              <input name="system.resources.mp.label" type="text" value="Mana Points" placeholder="Mana Points">
            </h4>
            <div class="resource-value">
              <input name="system.resources.mp.value" type="text" value="${mpValue}" data-dtype="Number" placeholder="0">
              <span class="sep"> / </span>
              <input name="system.resources.mp.max" type="text" value="${mpMax}" data-dtype="Number" placeholder="0">
            </div>
            <div class="resource-recovery">
              <label class="checkbox">
                <input type="checkbox" name="system.resources.mp.sr" ${actor.system.resources.mp?.sr ? 'checked' : ''}>
                <span class="tag">SR</span>
              </label>
              <label class="checkbox">
                <input type="checkbox" name="system.resources.mp.lr" ${actor.system.resources.mp?.lr ? 'checked' : ''}> 
                <span class="tag">LR</span>
              </label>
            </div>
          </li>
        `;
        
        resourcesElement.find('ul.resources-list').append(mpHtml);
      }
    }
  }
  
  // Add Magecraft filter to ability-based dropdowns and filters
  const abilitySelects = html.find('select.ability-select');
  abilitySelects.each((i, el) => {
    const select = $(el);
    if (!select.find('option[value="mgc"]').length) {
      select.append('<option value="mgc">Magecraft</option>');
    }
  });
  
  return html;
}

/**
 * Helper function to calculate Mana Points (MP)
 */
function calculateMP(actor) {
  if (!actor) return 0;
  
  const mgcMod = actor.system.abilities.mgc?.mod || 0;
  const profBonus = actor.system.attributes.prof || 0;
  const level = actor.system.details.level || 1;
  
  // Base MP formula: 20 + mgcMod + profBonus + (level * 1d10)
  // We'll calculate average of 1d10 which is 5.5 per level
  return Math.floor(20 + mgcMod + profBonus + (level * 5.5));
}

/**
 * Expose methods for macros and other modules
 */
window.MagecraftAbility = {
  roll: (actor) => actor.rollAbility('mgc'),
  rollCheck: (actor) => actor.rollAbilityTest('mgc'),
  rollSave: (actor) => actor.rollAbilitySave('mgc'),
  calculateMP: calculateMP,
  
  /**
   * Sets the Magecraft score for an actor
   */
  setScore: async (actor, score) => {
    if (!actor) return;
    
    // Enforce min/max boundaries
    const min = actor.system.abilities.mgc?.min || 3;
    const max = actor.system.abilities.mgc?.max || 20;
    
    if (score < min) score = min;
    if (score > max) score = max;
    
    return actor.update({"system.abilities.mgc.value": score});
  },
  
  /**
   * Spends MP from the actor's pool
   */
  spendMP: async (actor, amount) => {
    if (!actor || !actor.system.resources.mp) return false;
    
    const currentMP = actor.system.resources.mp.value;
    if (currentMP < amount) return false;
    
    await actor.update({"system.resources.mp.value": currentMP - amount});
    return true;
  },
  
  /**
   * Recovers MP for the actor
   */
  recoverMP: async (actor, amount) => {
    if (!actor || !actor.system.resources.mp) return false;
    
    const currentMP = actor.system.resources.mp.value;
    const maxMP = actor.system.resources.mp.max;
    
    // Don't exceed max MP
    const newMP = Math.min(currentMP + amount, maxMP);
    
    await actor.update({"system.resources.mp.value": newMP});
    return true;
  }
};

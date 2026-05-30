const fs = require('fs');
const path = require('path');

// JSON to JavaScript module converter for React Native
class JsonToJsConverter {
    constructor() {
        this.jsonDir = path.join(__dirname, '../data/json');
        this.dataDir = path.join(__dirname, '../data');
        
        // Ensure data directory exists
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    // Convert single JSON file to JavaScript module
    convertJsonToJs(jsonFileName) {
        const jsonPath = path.join(this.jsonDir, jsonFileName);
        const jsFileName = jsonFileName.replace('.json', 'Data.ts');
        const jsPath = path.join(this.dataDir, jsFileName);

        console.log(`Converting ${jsonFileName} to ${jsFileName}...`);

        try {
            // Read JSON file
            const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            
            // Create TypeScript module content
            const moduleContent = `// Auto-generated from ${jsonFileName}
// Dictionary data for ${jsonFileName.replace('.json', '')} language mode

export interface DictionaryEntry {
  ID: number;
  word: string;
  kurdish_meaning: string;
  uk_ipa?: string;
  us_ipa?: string;
}

export const ${jsonFileName.replace('.json', '')}Data: DictionaryEntry[] = ${JSON.stringify(jsonData, null, 2)};

export default ${jsonFileName.replace('.json', '')}Data;
`;

            // Write JavaScript module
            fs.writeFileSync(jsPath, moduleContent);
            
            console.log(`✅ Converted ${jsonFileName} to ${jsFileName}`);
            console.log(`   Entries: ${jsonData.length.toLocaleString()}, Size: ${(fs.statSync(jsPath).size / 1024 / 1024).toFixed(2)} MB\n`);

            return jsonData.length;

        } catch (error) {
            console.error(`❌ Error converting ${jsonFileName}:`, error.message);
            return 0;
        }
    }

    // Convert all JSON files to JavaScript modules
    convertAll() {
        console.log('🔄 Starting JSON to JavaScript conversion...\n');
        
        // Get all JSON files
        const jsonFiles = fs.readdirSync(this.jsonDir)
            .filter(file => file.endsWith('.json'))
            .sort();

        if (jsonFiles.length === 0) {
            console.log('No JSON files found in', this.jsonDir);
            return;
        }

        console.log(`Found ${jsonFiles.length} JSON files to convert:\n`);

        let totalConverted = 0;
        const results = [];

        // Convert each JSON file
        jsonFiles.forEach(jsonFile => {
            const entryCount = this.convertJsonToJs(jsonFile);
            if (entryCount > 0) {
                totalConverted++;
                results.push({
                    file: jsonFile,
                    entries: entryCount
                });
            }
        });

        // Create index file for easy imports
        this.createIndexFile(results);

        // Summary
        console.log('📊 Conversion Summary:');
        console.log(`✅ Successfully converted: ${totalConverted}/${jsonFiles.length} files`);
        console.log('\nFile Details:');
        
        results.forEach(result => {
            console.log(`  ${result.file.replace('.json', 'Data.ts')}: ${result.entries.toLocaleString()} entries`);
        });

        console.log(`\n🎉 All TypeScript data files saved to: ${this.dataDir}`);
        console.log(`📝 Index file created: ${path.join(this.dataDir, 'index.ts')}`);
    }

    // Create index file for easy imports
    createIndexFile(results) {
        const indexPath = path.join(this.dataDir, 'index.ts');
        
        let indexContent = `// Auto-generated index file for dictionary data modules
// Import any language mode data using: import { entokuData } from './data';

`;

        // Add imports
        results.forEach(result => {
            const moduleName = result.file.replace('.json', '');
            const fileName = result.file.replace('.json', 'Data');
            indexContent += `export { default as ${moduleName}Data } from './${fileName}';\n`;
        });

        indexContent += `\n// Language mode mapping for easy access
export const languageModes = {
`;

        results.forEach(result => {
            const moduleName = result.file.replace('.json', '');
            indexContent += `  '${moduleName}': () => import('./${moduleName}Data'),\n`;
        });

        indexContent += `};

// Get data for specific language mode
export const getLanguageData = async (mode: string) => {
  const moduleLoader = languageModes[mode as keyof typeof languageModes];
  if (moduleLoader) {
    const module = await moduleLoader();
    return module.default;
  }
  throw new Error(\`Language mode '\${mode}' not found\`);
};
`;

        fs.writeFileSync(indexPath, indexContent);
        console.log(`📝 Created index file: index.ts`);
    }
}

// Command line usage
const converter = new JsonToJsConverter();

// Get command line arguments
const args = process.argv.slice(2);

if (args.length === 0) {
    // Convert all files
    converter.convertAll();
} else {
    // Convert specific language mode
    const mode = args[0];
    const jsonFile = `${mode}.json`;
    converter.convertJsonToJs(jsonFile);
}

module.exports = JsonToJsConverter;

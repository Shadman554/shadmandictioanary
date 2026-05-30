const fs = require('fs');
const path = require('path');

// CSV to JSON converter for dictionary data
class CsvToJsonConverter {
    constructor() {
        this.csvDir = path.join(__dirname, '../data/csv');
        this.jsonDir = path.join(__dirname, '../data/json');
        
        // Ensure JSON directory exists
        if (!fs.existsSync(this.jsonDir)) {
            fs.mkdirSync(this.jsonDir, { recursive: true });
        }
    }

    // Parse CSV line handling quoted fields and commas
    parseCsvLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        
        result.push(current.trim());
        return result;
    }

    // Convert single CSV file to JSON
    convertCsvToJson(csvFileName) {
        const csvPath = path.join(this.csvDir, csvFileName);
        const jsonFileName = csvFileName.replace('.csv', '.json');
        const jsonPath = path.join(this.jsonDir, jsonFileName);

        console.log(`Converting ${csvFileName}...`);

        try {
            // Read CSV file
            const csvContent = fs.readFileSync(csvPath, 'utf8');
            const lines = csvContent.split('\n').filter(line => line.trim());
            
            if (lines.length === 0) {
                console.log(`Warning: ${csvFileName} is empty`);
                return;
            }

            // Parse header
            const headers = this.parseCsvLine(lines[0]);
            console.log(`Headers: ${headers.join(', ')}`);

            // Parse data rows
            const jsonData = [];
            let processedCount = 0;

            for (let i = 1; i < lines.length; i++) {
                const values = this.parseCsvLine(lines[i]);
                
                if (values.length !== headers.length) {
                    console.log(`Warning: Line ${i + 1} has ${values.length} values but expected ${headers.length}`);
                    continue;
                }

                // Create object from headers and values
                const rowObject = {};
                headers.forEach((header, index) => {
                    let value = values[index];
                    
                    // Clean up the value
                    if (value.startsWith('"') && value.endsWith('"')) {
                        value = value.slice(1, -1);
                    }
                    
                    // Convert ID to number if it's the ID field
                    if (header.toLowerCase() === 'id') {
                        value = parseInt(value) || 0;
                    }
                    
                    rowObject[header] = value;
                });

                jsonData.push(rowObject);
                processedCount++;

                // Progress indicator for large files
                if (processedCount % 1000 === 0) {
                    console.log(`  Processed ${processedCount} rows...`);
                }
            }

            // Write JSON file
            fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
            
            console.log(`✅ Converted ${csvFileName} to ${jsonFileName}`);
            console.log(`   Rows: ${processedCount}, Size: ${(fs.statSync(jsonPath).size / 1024 / 1024).toFixed(2)} MB\n`);

            return jsonData.length;

        } catch (error) {
            console.error(`❌ Error converting ${csvFileName}:`, error.message);
            return 0;
        }
    }

    // Convert all CSV files to JSON
    convertAll() {
        console.log('🔄 Starting CSV to JSON conversion...\n');
        
        // Get all CSV files
        const csvFiles = fs.readdirSync(this.csvDir)
            .filter(file => file.endsWith('.csv'))
            .sort();

        if (csvFiles.length === 0) {
            console.log('No CSV files found in', this.csvDir);
            return;
        }

        console.log(`Found ${csvFiles.length} CSV files to convert:\n`);

        let totalConverted = 0;
        const results = [];

        // Convert each CSV file
        csvFiles.forEach(csvFile => {
            const rowCount = this.convertCsvToJson(csvFile);
            if (rowCount > 0) {
                totalConverted++;
                results.push({
                    file: csvFile,
                    rows: rowCount
                });
            }
        });

        // Summary
        console.log('📊 Conversion Summary:');
        console.log(`✅ Successfully converted: ${totalConverted}/${csvFiles.length} files`);
        console.log('\nFile Details:');
        
        results.forEach(result => {
            console.log(`  ${result.file.replace('.csv', '.json')}: ${result.rows.toLocaleString()} entries`);
        });

        console.log(`\n🎉 All JSON files saved to: ${this.jsonDir}`);
    }

    // Convert specific language mode
    convertLanguageMode(mode) {
        const csvFile = `${mode}.csv`;
        const csvPath = path.join(this.csvDir, csvFile);
        
        if (!fs.existsSync(csvPath)) {
            console.log(`❌ CSV file not found: ${csvFile}`);
            return;
        }

        console.log(`🔄 Converting ${mode} language mode...\n`);
        const rowCount = this.convertCsvToJson(csvFile);
        
        if (rowCount > 0) {
            console.log(`✅ ${mode}.json created with ${rowCount.toLocaleString()} entries`);
        }
    }
}

// Command line usage
const converter = new CsvToJsonConverter();

// Get command line arguments
const args = process.argv.slice(2);

if (args.length === 0) {
    // Convert all files
    converter.convertAll();
} else {
    // Convert specific language mode
    const mode = args[0];
    converter.convertLanguageMode(mode);
}

module.exports = CsvToJsonConverter;

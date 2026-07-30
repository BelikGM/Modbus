// Номер версии увеличивается на КАЖДОЙ сборке инсталлятора.
//
// Иначе у наладчика на объекте оказываются два разных «Modbus Controller Setup
// 1.0.0.exe», и понять, какой из них новее и что именно установлено, неоткуда:
// ни по имени файла, ни в «О программе», ни в списке установленных программ.
//
// Разряды десятичные, как и просили: 1.0.1 … 1.0.9 → 1.1.0 … 1.9.9 → 2.0.0.
// Это НЕ semver (там после 1.0.9 идёт 1.0.10) — на сравнение версий в Windows
// и в electron-builder это не влияет, номер остаётся из трёх чисел.
const fs = require('fs')
const path = require('path')

const file = path.join(__dirname, '..', 'package.json')
const pkg = JSON.parse(fs.readFileSync(file, 'utf-8'))

const parts = String(pkg.version ?? '0.0.0').split('.').map(n => parseInt(n, 10) || 0)
let [major, minor, patch] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]

patch += 1
if (patch > 9) { patch = 0; minor += 1 }
if (minor > 9) { minor = 0; major += 1 }

const previous = pkg.version
pkg.version = `${major}.${minor}.${patch}`
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')

console.log(`[version] ${previous} -> ${pkg.version}`)

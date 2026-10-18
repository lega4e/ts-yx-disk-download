import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import YXDownloader, { FolderNode } from './features/YXDownloader';

/** Красиво печатает дерево папок */
function printStructure(node: FolderNode, indent: string = ''): void {
  const label =
    node.path === '/'
      ? `/  (${node.filesCount} файлов)`
      : `${node.name}/  (${node.filesCount} файлов)`;

  console.log(`${indent}${label}`);

  const childIndent = indent + '  ';
  for (const child of node.children) {
    printStructure(child, childIndent);
  }
}

/** Спрашивает у пользователя строку */
async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

// ==================== MAIN ====================

async function main() {
  const token = process.env.yxdisktoken;

  if (!token) {
    console.error('Укажите токен в переменной yxdisktoken или прямо в коде');
    process.exit(1);
  }

  const yx = new YXDownloader(token);
  await yx.init();

  // console.log('Получаю структуру Диска...\n');
  // const structure = await yx.fetchStructure('/');
  // console.log('Структура Яндекс.Диска:\n');
  // printStructure(structure);

  console.log('\n----------------------------------------');
  const diskPath = await ask(
    'Введите путь папки на Диске для скачивания (например /Фото или /Документы/2024):\n> ',
  );

  if (!diskPath) {
    console.error('Путь не указан, выход.');
    process.exit(1);
  }

  const localDir = await ask('Куда сохранить локально (например ./downloads/Фото):\n> ');

  if (!localDir) {
    console.error('Локальный путь не указан, выход.');
    process.exit(1);
  }

  console.log(`\nНачинаю скачивание: ${diskPath} → ${localDir}\n`);

  await yx.downloadFolder(diskPath, localDir, { skipExisting: true });

  // В конце выводим список ошибок
  if (yx.failedFiles.length > 0) {
    console.log('\n========== Не удалось скачать ==========');
    for (const file of yx.failedFiles) {
      console.log(`- ${file}`);
    }
    console.log(`Всего ошибок: ${yx.failedFiles.length}`);
  } else {
    console.log('\nВсё скачано без ошибок!');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

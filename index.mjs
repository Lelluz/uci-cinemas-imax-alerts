import axios from "axios";
import cheerio from "cheerio";
import { diffArrays } from "diff";
import { S3 } from "@aws-sdk/client-s3";
import moment from "moment"

const s3 = new S3({ region: "eu-south-1" });
const bucketName = "uci-cinemas-imax-scraper-bucket-milan";
const scrapedDataFolderPath = "scraped-data";
const updatesFolderPath = "differences-data";
const url = "https://imax.ucicinemas.it/";
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHANNEL_CHAT_ID;

async function getHTML() {
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    throw error;
  }
}

function getMovieScript(input, startStr, endStr) {
  let startIndex = input.indexOf(startStr);
  let endIndex = input.indexOf(endStr, startIndex + startStr.length);

  return startIndex !== -1 && endIndex !== -1 && startIndex < endIndex
    ? input.substring(startIndex + startStr.length, endIndex)
    : null;
}

function getNewFilmSchema(days) {
  const outputList = [];

  for (const cinemaKey in days) {
    const eventsList = days[cinemaKey];
    const cinemaName = cinemaKey
      .replace("_", " ")
      .replace("-", " ")
      .replace(/\d+/g, "")
      .trim()
      .replace(/(?:^|\s)\S/g, (a) => a.toUpperCase())
      .replace(/\b(\w)/g, (match) => match.toUpperCase())
      .replace(/-(\w)/g, (match, group1) => ` ${group1.toUpperCase()}`);

    for (const event of eventsList) {
      const date = event.date;

      for (const timeInfo of event.events) {
        const movieTitle = timeInfo.movieTitle;

        for (const time of timeInfo.times) {
          outputList.push({
            movieTitle: movieTitle,
            date: date,
            time: time.time || "N/A",
            cinemaName: cinemaName || "N/A",
          });
        }
      }
    }
  }
  return outputList;
}

async function saveToFile(data, filePath) {
  const params = {
    Bucket: bucketName,
    Key: filePath,
    Body: JSON.stringify(data, null, 2),
  };

  try {
    const response = await s3.putObject(params);
    console.log("File saved successfully.", response);
  } catch (error) {
    console.error("Error uploading file to S3:", error);
    throw error;
  }
}

async function compareLatestTwoFiles(scrapedDataFolderPath) {
  const params = {
    Bucket: bucketName,
    Prefix: scrapedDataFolderPath,
  };

  try {
    const data = await s3.listObjectsV2(params);
    const scrapedDataFiles = data.Contents.sort(
      (a, b) => b.LastModified - a.LastModified
    );
    const [latestFile, penultimateFile] = scrapedDataFiles.slice(0, 2);

    if (latestFile && penultimateFile) {
      const latestFilePath = latestFile.Key;
      const penultimateFilePath = penultimateFile.Key;

      const latestS3FileObj = await getObjectFromS3(latestFilePath);
      const penultimateS3FileObj = await getObjectFromS3(penultimateFilePath);

      const differences = diffArrays(
        JSON.parse(latestS3FileObj),
        JSON.parse(penultimateS3FileObj),
        {
          comparator: (a, b) => a.movieTitle === b.movieTitle,
        }
      );

      console.log("Comparing:", penultimateFilePath, "and", latestFilePath);

      if (differences.some((part) => part.added || part.removed)) {
        console.log("Differences detected.");
        await saveDifferencesToFile(differences);

        const telegramChannelMessageText = `
          È stata aggiornata la programmazione dei film UCI Cinemas nelle sale IMAX! 🎥 🍿
          
          ${url}
            
          `;
        await sendTelegramAlert(telegramChannelMessageText);
      } else {
        console.log("No differences found.");
      }
    } else {
      console.log("Not enough files for comparison.");
    }
  } catch (error) {
    console.error("Error in file comparison:", error);
  }
}

async function getObjectFromS3(filePath) {
  try {
    const response = await s3.getObject({ Bucket: bucketName, Key: filePath });
    return await response.Body?.transformToString();
  } catch (error) {
    console.error("Error retrieving object from S3:", error);
    throw error;
  }
}

async function saveDifferencesToFile(differences) {
  try {
    const timestamp = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\./g, "-");
    const differencesFilePath = `${updatesFolderPath}/differences_${timestamp}.json`;

    const filteredDifferences = differences.filter(
      (part) => part.added || part.removed
    );

    await saveToFile(filteredDifferences, differencesFilePath);
    console.log("Differences saved to:", differencesFilePath);
  } catch (error) {
    console.error("Error saving differences to file:", error);
  }
}

async function sendTelegramAlert(message) {
  const apiUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
  const params = {
    chat_id: telegramChatId,
    text: message,
  };

  try {
    const response = await axios.post(apiUrl, params);

    return {
      statusCode: response.status,
      body: JSON.stringify(response.data),
    };
  } catch (error) {
    console.error("Error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal Server Error" }),
    };
  }
}

async function deleteAllOldFilesInFolder(folderPath) {
  try {
    const objects = await s3.listObjectsV2({ Bucket: bucketName, Prefix: folderPath });
    const oneHourAgo = moment().subtract(1, 'hours');

    for (const obj of objects.Contents || []) {
        const lastModified = moment(obj.LastModified);

        if (lastModified.isBefore(oneHourAgo)) {
            await s3.deleteObject({ Bucket: bucketName, Key: obj.Key });
        }
    }

    console.log('File eliminati con successo.');
    return {
        statusCode: 200,
        body: JSON.stringify('Operazione completata con successo.'),
    };
  } catch (error) {
      console.error('Errore durante l\'eliminazione dei file:', error);
      return {
          statusCode: 500,
          body: JSON.stringify('Errore durante l\'eliminazione dei file.'),
      };
  }
}

export const handler = async (event) => {
  try {
    const timestamp = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\./g, "-");
    const newScrapedDataFilePath = `${scrapedDataFolderPath}/scraped-data_${timestamp}.json`;

    const res = await getHTML();
    const $ = cheerio.load(res, { xmlMode: false });
    const script = $("script").text();
    const moviesScript = getMovieScript(
      script,
      "moment.locale('it')",
      "function gotToBuyPage(pid) {"
    );
    const iifeMoviesScript = `
      (() => {
        ${moviesScript}
        return({
          times: times,
          movies: movies,
          days: days
        });
      })()
    `;

    const evalObject = eval(iifeMoviesScript);

    const TIMES = evalObject.times,
      MOVIES = evalObject.movies,
      DAYS = evalObject.days;

    const newFilmSchema = getNewFilmSchema(DAYS);

    await saveToFile(newFilmSchema, newScrapedDataFilePath);
    console.log("New data saved to:", newScrapedDataFilePath);

    await compareLatestTwoFiles(scrapedDataFolderPath);
    await deleteAllOldFilesInFolder(scrapedDataFolderPath);
    await deleteAllOldFilesInFolder(updatesFolderPath);
  } catch (error) {
    console.error("Error in Lambda function:", error);
  }
};

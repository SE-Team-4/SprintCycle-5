const express = require('express');
const MongoClient = require('mongodb').MongoClient;
const app = express();
const PORT = process.env.PORT || 3000;
const { ObjectId } = require('mongodb');
require('dotenv').config();

let dbConnectionStr = process.env.DB_STRING;
let classesCollection;
let student1Collection;
let db;
let selectedStudent = '10289';

app.set('view engine', 'ejs');

// Connect to the MongoDB database at the start
MongoClient.connect(dbConnectionStr, { useUnifiedTopology: true })
  .then(client => {
    console.log(`Connected to Database`);
    const database = client.db('CourseTimeline');
    classesCollection = database.collection('classes');
    student1Collection = database.collection('student1');
    db = database;
  })
  .catch(error => {
    console.error('Error connecting to the database:', error);
  });

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Define a function to fetch the currentCourses for the selected student
async function fetchCurrentCourses() {
  try {
    if (!selectedStudent) {
      return [];
    }

    const student = await student1Collection.findOne({ studentId: selectedStudent });

    if (student && student.currentCourses) {
      const currentCourseIds = student.currentCourses;

      // Perform a lookup to retrieve class/course names based on _id values
      const currentCourses = await classesCollection
        .find({ _id: { $in: currentCourseIds } })
        .toArray();

      return currentCourses.map(course => course.courseNumber + ": " + course.courseTitle);
    } else {
      return [];
    }
  } catch (error) {
    throw error;
  }
}

// Define the function to calculate progress
async function calculateProgress(studentId) {
  try {
    if (db) {
      const student = await student1Collection.findOne({ studentId });
      if (student) {
        const major = student.major;
        const coursesTaken = student.coursesTaken;

        const courseData = await classesCollection.find({ _id: { $in: coursesTaken } }).toArray();

        const totalCreditsFromCourses = courseData.reduce((total, course) => total + course.creditHours, 0);

        const majorsCollection = db.collection('majors');
        const majorData = await majorsCollection.findOne({ name: major });

        if (majorData) {
          const creditsNeededForCompletion = majorData.creditsNeededForCompletion;
          const progress = ((totalCreditsFromCourses / creditsNeededForCompletion) * 100).toFixed(2);
          return progress;
        }
      }
    }

    return null;
  } catch (error) {
    console.error(`Error: ${error}`);
    throw error;
  }
}

// HOME PAGE
app.get('/', async (req, res) => {
  try {
    // Fetch the progress and currentCourses for the selected student
    const progress = await calculateProgress(selectedStudent);
    const currentCourses = await fetchCurrentCourses();

    if (progress !== null) {
      res.render('index', { progress, currentCourses });
    } else {
      res.status(404).send('Student not found or data not available');
    }
  } catch (error) {
    console.error(`Error: ${error}`);
    res.status(500).send('Internal Server Error');
  }
});


// PLAN AHEAD PAGE
app.get('/planAhead', async (req, res) => {
  try {
    if (!selectedStudent) {
      res.status(400).send('No student selected');
      return;
    }

    const student = await student1Collection.aggregate([
      {
        $match: { studentId: selectedStudent }
      },
      {
        $lookup: {
          from: 'classes',
          localField: 'coursesTaken',
          foreignField: '_id',
          as: 'coursesTaken'
        }
      },
      {
        $lookup: {
          from: 'classes',
          localField: 'currentCourses',
          foreignField: '_id',
          as: 'currentCourses'
        }
      }
    ]).toArray();

    if (student.length === 0) {
      res.status(404).send('Student not found');
      return;
    }

    const allClasses = await classesCollection.find().toArray();
    const studentCoursesTaken = student[0].coursesTaken;
    const studentCurrentCourses = student[0].currentCourses;

    const totalCreditsTaken = studentCoursesTaken.reduce((total, course) => total + course.creditHours, 0);
    const totalCreditsCurrent = studentCurrentCourses.reduce((total, course) => total + course.creditHours, 0);

    const coursesNotTaken = allClasses.filter(course => {
      return !studentCoursesTaken.some(c => c._id.toString() === course._id.toString()) && !studentCurrentCourses.some(c => c._id.toString() === course._id.toString());
    });

    const studentWithCourses = {
      name: student[0].name,
      creditsCompleted: totalCreditsTaken + totalCreditsCurrent,
      coursesTaken: studentCoursesTaken,
      currentCourses: studentCurrentCourses,
      coursesNotTaken: coursesNotTaken
    };

    res.render('planAhead', { student: studentWithCourses });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Internal Server Error');
  }
});


async function fetchAllCourses() {
  try {
    const allClasses = await classesCollection.find({}, { courseNumber: 1, creditHours: 1 }).toArray();
    return allClasses;
  } catch (error) {
    throw error;
  }
}

let currentCourses = [];

// PLANNER PAGE
app.get('/planner', async (req, res) => {
  try {
    // Define coursesNotTaken as an empty array
    let coursesNotTaken = [];
    let activeCourses = [];

    // Populate coursesNotTaken based on the conditions in your GET route
    const student = await student1Collection.findOne({ studentId: selectedStudent });

    if (student) {
      const allClasses = await fetchAllCourses();
      coursesNotTaken = allClasses.filter(course => {
        if (!student.coursesTaken.includes(course._id)  && !student.currentCourses.includes(course._id)) {
          // Check if the student has all prerequisites for this course
          const prerequisitesMet = course.prerequisites.every(prereq => {
            const met = student.currentCourses.includes(prereq) || student.coursesTaken.includes(prereq);
            return met;
          });
          return prerequisitesMet;
        }
        return false;
      });
    }

    if (student) {
      let currentCourses = student.currentCourses;

      const allClasses = await fetchAllCourses();

      // Find active courses that are in currentCourses
      activeCourses = allClasses.filter(course => currentCourses.includes(course._id));

      const recommendations = [];
      activeCourses.forEach(activeCourse => {
        if (activeCourse.nextCourses && Array.isArray(activeCourse.nextCourses)) {
          const activeCourseRecommendations = allClasses.filter(course =>
            course._id !== activeCourse._id && // Exclude the active course
            activeCourse.nextCourses.includes(course._id) &&
            !currentCourses.includes(course._id) && // Check if the course is not in currentCourses
            !student.coursesTaken.includes(course._id) // Check if the course is not in coursesTaken
          );

          if (activeCourseRecommendations.length > 0) {
            recommendations.push({
              course: activeCourse,
              recommendedCourses: activeCourseRecommendations,
            });
          }
        }
      });

      currentCourses = [];

      // Render the 'planner' template and pass the data
      res.render('planner', {
        coursesNotTaken,
        currentCourses,
        activeCourses,
        recommendations,
      });
    } else {
      // Handle the case where the student is not found
      res.status(404).send('Student not found');
    }
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Internal Server Error');
  }
});


app.post('/planner', async (req, res) => {
  try {
    // Define coursesNotTaken as an empty array
    let coursesNotTaken = [];
    //let activeCourses = [];
    let recommendations = [];
    
    const selectedCourseIds = req.body.selectedCourses;
    if (!selectedCourseIds || (!Array.isArray(selectedCourseIds) && !Array.isArray([selectedCourseIds]))) {
      res.status(400).send('Invalid course selections');
      return;
    }    

    // Fetch all courses, including the creditHours field
    const allClasses = await fetchAllCourses();

    // Calculate selectedCourses
    const selectedCourses = allClasses.filter(course => selectedCourseIds.includes(course._id));

    // Retrieve the current courses from the hidden input field
    currentCourses = JSON.parse(req.body.currentCourses);

    // Pass 'coursesNotTaken' and 'currentCourses' when rendering the template
    res.render('planner', {
      coursesNotTaken: coursesNotTaken,
      selectedCourses: selectedCourses,
      currentCourses: currentCourses.concat(selectedCourses),
      recommendations: recommendations,
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// DISCOVER PAGE

async function getPrerequisiteCourseNumbers(prerequisiteIds) {
  if (!prerequisiteIds || prerequisiteIds.length === 0) {
      return [];
  }

  const prerequisiteCourses = await classesCollection.find({ _id: { $in: prerequisiteIds } }).toArray();
  return prerequisiteCourses.map(course => course.courseNumber);
}

app.get('/api/search', async (req, res) => {
  const query = req.query.q || '';
  let results = [];

  if (query) {
      results = await classesCollection.find({ "courseNumber": new RegExp(query, 'i') }).toArray();
  } else {
      results = await classesCollection.find().toArray();
  }

  // Fetch prerequisites for each course
for (let course of results) {
  if (course.prerequisites && course.prerequisites.length > 0) {
    console.log("Before processing: ", course.prerequisites);
    const prerequisitesCourses = await classesCollection.find({ _id: { $in: course.prerequisites.map(id => id) } }).toArray();
    course.prerequisites = prerequisitesCourses.map(course => course.courseNumber);
    console.log("After processing: ", course.prerequisites);
  }
}

  res.json(results);
});

app.get('/discover', async (req, res) => {
  let results = await classesCollection.find().toArray();

  // For each course in results
  for(let course of results) {
      if(course.prerequisites && course.prerequisites.length > 0) {
          // Fetch the course numbers for each prerequisite
          const prerequisiteCourses = await getPrerequisiteCourseNumbers(course.prerequisites);
          course.prerequisites = prerequisiteCourses;
      }
  }

  res.render('discover', { results });
});

// WHAT IF PAGE

app.get('/whatIf', (req, res) => {
  res.render('whatIf');
});

app.listen(process.env.PORT || PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

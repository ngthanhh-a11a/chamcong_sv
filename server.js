const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const exceljs = require('exceljs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. Log mọi request bay vào để dễ debug
app.use((req, res, next) => {
    console.log(`[API Nhận tín hiệu] -> ${req.method} ${req.url}`);
    next();
});

// 2. Kết nối MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Đã kết nối DB thành công'))
  .catch(err => console.error('❌ Lỗi DB:', err));

// 3. KHAI BÁO MODEL (SCHEMAS)
const studentSchema = new mongoose.Schema({
    uid: { type: String, required: true, unique: true },
    fullName: { type: String, required: true },
    registeredAt: { type: Date, default: Date.now }
});
const Student = mongoose.model('Student', studentSchema);

const logSchema = new mongoose.Schema({
    uid: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    status: { type: String, enum: ['Đúng giờ', 'Đi muộn', 'Ngoài giờ', 'Chưa đăng ký'] },
    shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', default: null }
});
const AttendanceLog = mongoose.model('AttendanceLog', logSchema);

const shiftSchema = new mongoose.Schema({
    shiftID: { type: String, required: true, unique: true }, // Vd: "MORNING", "AFTERNOON"
    shiftName: { type: String, required: true }, // Vd: "Ca Sáng", "Ca Chiều"
    startTime: { type: String, required: true }, // Vd: "07:00"
    endTime: { type: String, required: true },   // Vd: "11:30"
    lateThreshold: { type: Number, default: 15 }, // Vd: 15 phút
    isActive: { type: Boolean, default: true }
});
const Shift = mongoose.model('Shift', shiftSchema);

// Tự động tạo cấu hình mặc định nếu database chưa có
async function initDefaultShifts() {
    const count = await Shift.countDocuments({});
    if (count === 0) {
        await Shift.insertMany([
            { shiftID: 'MORNING', shiftName: 'Ca Sáng', startTime: '07:30', endTime: '11:30', lateThreshold: 15, isActive: true },
            { shiftID: 'AFTERNOON', shiftName: 'Ca Chiều', startTime: '13:00', endTime: '17:00', lateThreshold: 15, isActive: true }
        ]);
        console.log("⚙️ Đã tạo 2 ca học mặc định (Sáng, Chiều) vào Database");
    }
}
initDefaultShifts();

// Thuật toán nhận diện ca học tự động
const findShiftForTime = (time, activeShifts) => {
    const now = new Date(time);
    const nowTotalMinutes = now.getHours() * 60 + now.getMinutes();
    const PRE_SHIFT_WINDOW = 30; // Cho phép quẹt thẻ trước 30 phút

    // Sắp xếp các ca theo thời gian bắt đầu để ưu tiên ca sớm hơn nếu có chồng chéo
    const sortedShifts = [...activeShifts].sort((a, b) => {
        const aStart = a.startTime.split(':').map(Number);
        const bStart = b.startTime.split(':').map(Number);
        return (aStart[0] * 60 + aStart[1]) - (bStart[0] * 60 + bStart[1]);
    });

    for (const shift of sortedShifts) {
        const [startHour, startMin] = shift.startTime.split(':').map(Number);
        const shiftStartMinutes = (startHour * 60) + startMin;

        const [endHour, endMin] = shift.endTime.split(':').map(Number);
        const shiftEndMinutes = (endHour * 60) + endMin;

        const windowStart = shiftStartMinutes - PRE_SHIFT_WINDOW;
        const windowEnd = shiftEndMinutes;

        if (nowTotalMinutes >= windowStart && nowTotalMinutes <= windowEnd) {
            return shift; // Trả về ca học phù hợp đầu tiên tìm thấy
        }
    }

    return null; // Không tìm thấy ca học phù hợp
};

// 4. ĐỊNH TUYẾN API (ROUTES)

// API nhận dữ liệu điểm danh từ ESP32
app.post('/api/attendance', async (req, res) => {
    try {
        const { uid } = req.body;
        if (!uid) {
            return res.status(400).json({ error: "Thiếu mã UID" });
        }

        console.log(`📡 Đang xử lý thẻ UID: ${uid}`);

        // 1. Lấy thông tin sinh viên và các ca học đang hoạt động
        const student = await Student.findOne({ uid });
        const activeShifts = await Shift.find({ isActive: true });
        const now = new Date();

        // 2. Chạy thuật toán nhận diện ca học
        const identifiedShift = findShiftForTime(now, activeShifts);

        // 3. Phân loại trạng thái điểm danh
        let currentStatus = "Chưa đăng ký";
        let studentName = "Thẻ lạ";
        let shiftIdToLog = null;

        if (student) { // Nếu thẻ đã được đăng ký
            studentName = student.fullName;
            if (identifiedShift) { // Nếu thời gian quẹt thẻ rơi vào một ca học
                shiftIdToLog = identifiedShift._id;
                const [shiftHour, shiftMin] = identifiedShift.startTime.split(':').map(Number);
                const shiftStartMinutes = (shiftHour * 60) + shiftMin;
                const nowTotalMinutes = now.getHours() * 60 + now.getMinutes();

                // So sánh với mốc giờ vào lớp + số phút châm chước
                if (nowTotalMinutes <= (shiftStartMinutes + identifiedShift.lateThreshold)) {
                    currentStatus = "Đúng giờ";
                } else {
                    currentStatus = "Đi muộn";
                }
            } else {
                currentStatus = "Ngoài giờ";
            }
        }
        // Nếu thẻ chưa đăng ký, trạng thái mặc định là "Chưa đăng ký"

        // 4. Lưu log vào database
        const newLog = new AttendanceLog({ uid, status: currentStatus, shift: shiftIdToLog });
        await newLog.save();

        console.log(`✅ Lưu thành công: ${studentName} - Ca: ${identifiedShift ? identifiedShift.shiftName : 'N/A'} - Trạng thái: ${currentStatus}`);

        res.status(201).json({
            message: "Điểm danh thành công",
            student: studentName,
            status: currentStatus
        });

    } catch (error) {
        console.error("Lỗi xử lý API:", error);
        res.status(500).json({ error: "Lỗi máy chủ nội bộ" });
    }
});

// API lấy lịch sử cho Dashboard
// API lấy lịch sử cho Dashboard (Đã nâng cấp: Hỗ trợ lọc theo ngày)
app.get('/api/logs', async (req, res) => {
    try {
        const dateQuery = req.query.date; // Nhận tham số ngày từ Frontend (VD: '2026-07-12')
        
        // Logic tạo bộ lọc theo ngày (ĐÃ CHUẨN HÓA MÚI GIỜ VIỆT NAM)
        let filter = {};
        if (dateQuery) {
            // Định nghĩa mốc thời gian bắt đầu và kết thúc của ngày đó THEO GIỜ VIỆT NAM (UTC+7)
            // Ép Node.js hiểu rằng chuỗi '00:00:00' này là của múi giờ +07:00
            const startOfDayVN = new Date(`${dateQuery}T00:00:00+07:00`);
            const endOfDayVN = new Date(`${dateQuery}T23:59:59+07:00`);

            // Yêu cầu MongoDB lọc dữ liệu nằm giữa 2 mốc thời gian này
            filter = { timestamp: { $gte: startOfDayVN, $lte: endOfDayVN } };
        }

        // Lấy tất cả các ca để có thể tính lại status cho log cũ
        const allShifts = await Shift.find({});
        const logs = await AttendanceLog.aggregate([
            { $match: filter }, // Áp dụng bộ lọc ngày vào Database
            { $sort: { timestamp: -1 } },
            // { $limit: 50 }, // Đã ẩn limit để biểu đồ vẽ được toàn bộ dữ liệu trong ngày
            { $lookup: { from: 'students', localField: 'uid', foreignField: 'uid', as: 'studentInfo' } }
        ]);

        const formattedLogs = logs.map(log => {
            const studentExists = log.studentInfo && log.studentInfo.length > 0;
            const fullName = studentExists ? log.studentInfo[0].fullName : null;
            let dynamicStatus = "Chưa đăng ký";
            
            if (studentExists) {
                const logTime = new Date(log.timestamp);
                // Chạy lại thuật toán nhận diện ca cho từng log
                const identifiedShift = findShiftForTime(logTime, allShifts);

                if (identifiedShift) {
                    const [shiftHour, shiftMin] = identifiedShift.startTime.split(':').map(Number);
                    const shiftStartMinutes = (shiftHour * 60) + shiftMin;
                    const logTotalMinutes = logTime.getHours() * 60 + logTime.getMinutes();
                    
                    dynamicStatus = logTotalMinutes <= (shiftStartMinutes + identifiedShift.lateThreshold) 
                        ? "Đúng giờ" 
                        : "Đi muộn";
                } else {
                    dynamicStatus = "Ngoài giờ";
                }
            }

            return {
                uid: log.uid,
                timestamp: log.timestamp,
                status: dynamicStatus,
                fullName: fullName,
            };
        });

        res.json(formattedLogs);
    } catch (error) {
        console.error("Lỗi truy xuất dữ liệu:", error);
        res.status(500).json({ error: "Lỗi truy xuất dữ liệu" });
    }
});

// API lấy danh sách sinh viên
app.get('/api/students', async (req, res) => {
    try {
        // Lấy toàn bộ sinh viên, sắp xếp người mới đăng ký lên đầu
        const students = await Student.find().sort({ registeredAt: -1 });
        res.json(students);
    } catch (error) {
        res.status(500).json({ error: "Lỗi lấy danh sách sinh viên" });
    }
});

// API Đăng ký thẻ mới (Đã cập nhật logic sửa hồi tố log cũ)
app.post('/api/students', async (req, res) => {
    try {
        const { uid, fullName } = req.body;
        
        if (!uid || !fullName) {
            return res.status(400).json({ error: "Thiếu mã UID hoặc Họ tên" });
        }

        // Lưu sinh viên mới
        const newStudent = new Student({ uid, fullName });
        await newStudent.save();
        
        // SQA Logic: Quét lại toàn bộ log cũ của UID này và cập nhật trạng thái
        const allShifts = await Shift.find({});
        const oldLogs = await AttendanceLog.find({ uid: uid });

        for (let log of oldLogs) {
            const logTime = new Date(log.timestamp);
            const identifiedShift = findShiftForTime(logTime, allShifts);

            if (identifiedShift) {
                const [shiftHour, shiftMin] = identifiedShift.startTime.split(':').map(Number);
                const shiftStartMinutes = (shiftHour * 60) + shiftMin;
                const logTotalMinutes = logTime.getHours() * 60 + logTime.getMinutes();

                log.status = logTotalMinutes <= (shiftStartMinutes + identifiedShift.lateThreshold) ? "Đúng giờ" : "Đi muộn";
                log.shift = identifiedShift._id; // Gán cả ca học đã nhận diện được
            } else {
                log.status = "Ngoài giờ";
                log.shift = null;
            }
            await log.save();
        }


        console.log(`[Đăng ký mới] Kích hoạt thẻ ${uid} cho ${fullName} và cập nhật ${oldLogs.length} log cũ.`);
        res.status(201).json({ message: "Đăng ký sinh viên thành công" });
    } catch (error) {
        console.error("Lỗi khi đăng ký thẻ:", error);
        res.status(400).json({ error: "Mã UID này đã tồn tại trong hệ thống!" });
    }
});

// API Sửa tên định danh sinh viên (Bổ sung mới)
app.put('/api/students/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        const { fullName } = req.body;

        if (!fullName) {
            return res.status(400).json({ error: "Tên không được để trống" });
        }

        const updatedStudent = await Student.findOneAndUpdate(
            { uid: uid },
            { fullName: fullName },
            { new: true } // Trả về document sau khi đã update
        );

        if (!updatedStudent) {
            return res.status(404).json({ error: "Không tìm thấy thẻ này trong hệ thống" });
        }

        console.log(`[Cập nhật] Thẻ ${uid} đổi tên thành ${fullName}`);
        res.json({ message: "Cập nhật thành công", student: updatedStudent });
    } catch (error) {
        console.error("Lỗi khi cập nhật tên thẻ:", error);
        res.status(500).json({ error: "Lỗi máy chủ" });
    }
});

// ==========================================
// API: CÀI ĐẶT HỆ THỐNG & CA HỌC
// ==========================================

// API lấy cấu hình các ca học hiện tại
app.get('/api/settings/shift', async (req, res) => {
    try {
        // Tìm tất cả ca học và sắp xếp theo giờ bắt đầu
        const shifts = await Shift.find().sort({ startTime: 1 });
        res.json(shifts);
    } catch (error) {
        res.status(500).json({ error: "Lỗi truy xuất cấu hình ca học" });
    }
});

// API lưu/cập nhật toàn bộ cấu hình ca học
app.post('/api/settings/shift', async (req, res) => {
    try {
        const incomingShifts = req.body; // Nhận mảng các ca học từ Frontend

        if (!Array.isArray(incomingShifts)) {
            return res.status(400).json({ error: "Dữ liệu gửi lên phải là một mảng (array) các ca học." });
        }

        // --- BƯỚC VALIDATION AN TOÀN (TRƯỚC KHI GHI VÀO DB) ---

        // 1. Kiểm tra xem có shiftID nào bị trùng trong mảng gửi lên không
        const shiftIDs = incomingShifts.map(s => s.shiftID);
        const hasDuplicateIDs = new Set(shiftIDs).size !== shiftIDs.length;
        if (hasDuplicateIDs) {
            // Dùng mã lỗi 409 (Conflict) để báo cho Frontend biết có sự trùng lặp dữ liệu
            return res.status(409).json({ error: "Lỗi: Mã ca (shiftID) không được trùng lặp trong danh sách." });
        }

        // 2. Validate từng object trong mảng để đảm bảo đúng cấu trúc Schema
        for (const shiftData of incomingShifts) {
            const shiftDoc = new Shift(shiftData);
            await shiftDoc.validate(); // Sẽ throw ValidationError nếu không hợp lệ
        }

        // --- KHI DỮ LIỆU ĐÃ HỢP LỆ, TIẾN HÀNH GHI ĐÈ ---
        // Xóa trắng cấu hình cũ và thay bằng cấu hình mới
        await Shift.deleteMany({});
        await Shift.insertMany(incomingShifts);

        console.log(`[Cấu hình] Đã cập nhật lại toàn bộ ${incomingShifts.length} ca học.`);
        res.json({ message: "Lưu cấu hình hệ thống thành công!" });
    } catch (error) {
        console.error("Lỗi lưu cấu hình ca học:", error);
        // Phản hồi lỗi validation chi tiết hơn cho Frontend
        if (error.name === 'ValidationError') {
            return res.status(400).json({ 
                error: "Dữ liệu ca học không hợp lệ. Vui lòng kiểm tra lại các trường đã nhập.",
                details: error.message 
            });
        }
        // Các lỗi 500 khác không lường trước được
        res.status(500).json({ error: "Lỗi máy chủ khi lưu cấu hình ca học." });
    }
});

// ==========================================
// API: XUẤT DỮ LIỆU JSON THEO KHOẢNG THỜI GIAN
// ==========================================
app.get('/api/logs/export', async (req, res) => {
    try {
        const { start, end } = req.query; // Nhận ngày bắt đầu và kết thúc từ Frontend
        let filter = {};

        if (start && end) {
            // Ép mốc thời gian theo chuẩn giờ Việt Nam (UTC+7)
            // Bắt đầu từ 00:00:00 của ngày Start đến 23:59:59 của ngày End
            const startTime = new Date(`${start}T00:00:00+07:00`);
            const endTime = new Date(`${end}T23:59:59+07:00`);

            filter.timestamp = {
                $gte: startTime,
                $lte: endTime
            };
        }

        // Lấy toàn bộ dữ liệu trong khoảng thời gian này, sắp xếp mới nhất lên đầu
        const logs = await AttendanceLog.aggregate([
            { $match: filter },
            { $sort: { timestamp: -1 } },
            { $lookup: { from: 'students', localField: 'uid', foreignField: 'uid', as: 'studentInfo' } }
        ]);

        const allShifts = await Shift.find({});

        // Map lại dữ liệu cho đẹp trước khi gửi về Frontend để Excel hiển thị rõ ràng
        const exportData = logs.map(log => {
            const studentExists = log.studentInfo && log.studentInfo.length > 0;
            const fullName = studentExists ? log.studentInfo[0].fullName : 'Thẻ lạ';
            let dynamicStatus = "Chưa đăng ký";

            if (studentExists) {
                const logTime = new Date(log.timestamp);
                const identifiedShift = findShiftForTime(logTime, allShifts);
                if (identifiedShift) {
                    const logTotalMinutes = logTime.getHours() * 60 + logTime.getMinutes();
                    const [shiftHour, shiftMin] = identifiedShift.startTime.split(':').map(Number);
                    const shiftTotalMinutes = (shiftHour * 60) + shiftMin;
                    dynamicStatus = logTotalMinutes <= (shiftTotalMinutes + identifiedShift.lateThreshold) ? "Đúng giờ" : "Đi muộn";
                } else {
                    dynamicStatus = "Ngoài giờ";
                }
            }

            return {
                "Mã Thẻ (UID)": log.uid,
                "Tên Sinh Viên": fullName,
                "Thời Gian Quẹt": new Date(log.timestamp).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
                "Trạng Thái": dynamicStatus
            };
        });

        res.json(exportData);
    } catch (error) {
        console.error("LỖI XUẤT DỮ LIỆU TẠI BACKEND:", error);
        res.status(500).json({ error: "Lỗi trích xuất dữ liệu" });
    }
});

// API xuất báo cáo ra file Excel
app.get('/api/report/excel', async (req, res) => {
    try {
        // 1. Lấy toàn bộ log và thông tin sinh viên liên quan
        const logs = await AttendanceLog.aggregate([
            { $sort: { timestamp: -1 } },
            { $lookup: { from: 'students', localField: 'uid', foreignField: 'uid', as: 'studentInfo' } }
        ]);

        const allShifts = await Shift.find({});

        // 2. Tạo Workbook và Worksheet mới
        const workbook = new exceljs.Workbook();
        workbook.creator = 'NTTU Smart Attendance System';
        workbook.created = new Date();
        const worksheet = workbook.addWorksheet('Báo cáo điểm danh');

        // 3. Định nghĩa cột và style cho header
        worksheet.columns = [
            { header: 'STT', key: 'stt', width: 5, style: { alignment: { horizontal: 'center' } } },
            { header: 'Mã UID', key: 'uid', width: 25 },
            { header: 'Họ và Tên', key: 'fullName', width: 30 },
            { header: 'Thời gian', key: 'timestamp', width: 25, style: { numFmt: 'dd/mm/yyyy hh:mm:ss' } },
            { header: 'Trạng thái', key: 'status', width: 15 }
        ];

        worksheet.getRow(1).eachCell((cell) => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4338CA' } }; // Indigo-700
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
            cell.border = { bottom: { style: 'thin', color: { argb: 'FF6366F1' } } };
        });

        // 4. Thêm dữ liệu vào các dòng
        logs.forEach((log, index) => {
            const studentExists = log.studentInfo && log.studentInfo.length > 0;
            const fullName = studentExists ? log.studentInfo[0].fullName : 'Thẻ lạ';
            let dynamicStatus = "Chưa đăng ký";

            if (studentExists) {
                const logTime = new Date(log.timestamp);
                const identifiedShift = findShiftForTime(logTime, allShifts);
                if (identifiedShift) {
                    const logTotalMinutes = logTime.getHours() * 60 + logTime.getMinutes();
                    const [shiftHour, shiftMin] = identifiedShift.startTime.split(':').map(Number);
                    const shiftTotalMinutes = (shiftHour * 60) + shiftMin;
                    dynamicStatus = logTotalMinutes <= (shiftTotalMinutes + identifiedShift.lateThreshold) ? "Đúng giờ" : "Đi muộn";
                } else {
                    dynamicStatus = "Ngoài giờ";
                }
            }

            worksheet.addRow({
                stt: logs.length - index, // Đếm ngược để người mới nhất ở dưới cùng
                uid: log.uid,
                fullName: fullName,
                timestamp: new Date(log.timestamp),
                status: dynamicStatus
            });
        });

        // 5. Thiết lập header và gửi file về client
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="BaoCaoDiemDanh_' + new Date().toISOString().slice(0,10) + '.xlsx"');

        await workbook.xlsx.write(res);
        res.end();
        console.log(`✅ Đã xuất báo cáo Excel thành công.`);
    } catch (error) {
        console.error("❌ Lỗi khi xuất file Excel:", error);
        res.status(500).send("Không thể tạo file báo cáo.");
    }
});

// ==========================================
// API TRA CỨU CÁ NHÂN (STUDENT PORTAL)
// ==========================================
app.get('/api/logs/student/:uid', async (req, res) => {
    try {
        const uid = req.params.uid.toUpperCase(); // Lấy mã UID từ đường link
        
        // 1. Kiểm tra xem sinh viên có tồn tại không
        const student = await Student.findOne({ uid: uid });
        if (!student) {
            return res.status(404).json({ error: "Không tìm thấy thẻ sinh viên này trên hệ thống!" });
        }

        // 2. Lấy cấu hình ca làm việc hiện tại để xét Đi muộn/Đúng giờ
        const allShifts = await Shift.find({});

        // 3. Truy vấn toàn bộ lịch sử của riêng sinh viên này
        const logs = await AttendanceLog.find({ uid: uid }).sort({ timestamp: -1 });

        // 4. Thống kê và format dữ liệu
        let onTimeCount = 0;
        let lateCount = 0;
        let outsideHoursCount = 0; // Thêm biến đếm

        const formattedLogs = logs.map(log => {
            const logTime = new Date(log.timestamp);
            const identifiedShift = findShiftForTime(logTime, allShifts);
            let status = "Ngoài giờ";
            
            if (identifiedShift) {
                const logTotalMinutes = (logTime.getHours() * 60) + logTime.getMinutes();
                const [h, m] = identifiedShift.startTime.split(':').map(Number);
                const shiftTotalMinutes = (h * 60) + m;
                
                if (logTotalMinutes <= (shiftTotalMinutes + identifiedShift.lateThreshold)) {
                    status = "Đúng giờ";
                    onTimeCount++;
                } else {
                    status = "Đi muộn";
                    lateCount++;
                }
            } else {
                outsideHoursCount++;
            }

            return { timestamp: log.timestamp, status: status };
        });

        // 5. Trả kết quả về cho Frontend
        res.json({
            student: student,
            stats: { total: logs.length, onTime: onTimeCount, late: lateCount, outside: outsideHoursCount },
            logs: formattedLogs
        });
    } catch (error) {
        res.status(500).json({ error: "Lỗi truy vấn dữ liệu" });
    }
});

// ==========================================
// API GIÁM SÁT HỆ THỐNG (SYSTEM HEALTH)
// ==========================================
app.get('/api/health', (req, res) => {
    res.json({
        uptime: Math.floor(process.uptime()), // Thời gian server đã chạy (giây)
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024), // Ram tiêu thụ (MB)
        dbStatus: mongoose.connection.readyState === 1 ? "Connected" : "Disconnected"
    });
});

// 5. KHỞI CHẠY SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend Server đã mở cửa tại cổng ${PORT}`);
    console.log(`👉 Chấp nhận kết nối từ mọi thiết bị (0.0.0.0)`);
});
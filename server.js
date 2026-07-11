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
    status: { type: String, enum: ['Đúng giờ', 'Đi muộn', 'Chưa đăng ký'] }
});
const AttendanceLog = mongoose.model('AttendanceLog', logSchema);

const shiftSchema = new mongoose.Schema({
    shiftName: { type: String, required: true, default: "Ca Hành chính" }, // VD: "Ca Sáng 23DTH1C", "Hành chính"
    startTime: { type: String, required: true, default: "07:30" }, // VD: "07:30"
    endTime: { type: String, required: true, default: "17:00" },   // VD: "11:30"
    lateThreshold: { type: Number, default: 15 }, // Số phút cho phép đi trễ (VD: 15 phút)
    isActive: { type: Boolean, default: true }
});
const Shift = mongoose.model('Shift', shiftSchema);

// Tự động tạo cấu hình mặc định nếu database chưa có
async function initDefaultShift() {
    const count = await Shift.countDocuments({});
    if (count === 0) {
        await new Shift().save();
        console.log("⚙️ Đã tạo cấu hình Ca động mặc định vào Database");
    }
}
initDefaultShift();

// 4. ĐỊNH TUYẾN API (ROUTES)

// API nhận dữ liệu điểm danh từ ESP32
app.post('/api/attendance', async (req, res) => {
    try {
        const { uid } = req.body;
        
        if (!uid) {
            return res.status(400).json({ error: "Thiếu mã UID" });
        }

        console.log(`📡 Đang xử lý thẻ UID: ${uid}`);

        // Kiểm tra xem thẻ đã đăng ký chưa
        const student = await Student.findOne({ uid });

        // Phân loại trạng thái
        // Lấy cấu hình ca hiện tại từ Database
        const shiftConfig = await Shift.findOne();
        let currentStatus = "Chưa đăng ký";
        
        if (student && shiftConfig) {
            const now = new Date();
            const currentHour = now.getHours();
            const currentMinute = now.getMinutes();
            const nowTotalMinutes = (currentHour * 60) + currentMinute; // Tổng phút hiện tại
            
            // Tách giờ cấu hình (VD: "07:30" -> 7 và 30)
            const [shiftHour, shiftMin] = shiftConfig.startTime.split(':').map(Number);
            const shiftTotalMinutes = (shiftHour * 60) + shiftMin; // Tổng phút quy định
            
            // So sánh: Nếu thời gian quẹt <= (Giờ quy định + Phút châm chước)
            if (nowTotalMinutes <= (shiftTotalMinutes + shiftConfig.lateThreshold)) {
                currentStatus = "Đúng giờ";
            } else {
                currentStatus = "Đi muộn";
            }
        }

        // Lưu log vào database
        const newLog = new AttendanceLog({ uid, status: currentStatus });
        await newLog.save();

        console.log(`✅ Lưu thành công: ${student ? student.fullName : 'Thẻ lạ'} - Trạng thái: ${currentStatus}`);

        res.status(201).json({ 
            message: "Điểm danh thành công", 
            student: student ? student.fullName : "Thẻ lạ",
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
        const { date } = req.query; // Nhận tham số ngày từ Frontend
        
        // Logic tạo bộ lọc theo ngày
        let dateFilter = {};
        if (date) {
            // Lọc từ 00:00:00 đến 23:59:59 của ngày được chọn
            const startOfDay = new Date(`${date}T00:00:00.000Z`);
            const endOfDay = new Date(`${date}T23:59:59.999Z`);
            dateFilter = { timestamp: { $gte: startOfDay, $lte: endOfDay } };
        }

        const shiftConfig = await Shift.findOne() || { startTime: "08:00", lateThreshold: 0 };
        const [h, m] = shiftConfig.startTime.split(':').map(Number);
        const shiftTotalMinutes = (h * 60) + m;

        const logs = await AttendanceLog.aggregate([
            { $match: dateFilter }, // Áp dụng bộ lọc ngày vào Database
            { $sort: { timestamp: -1 } },
            // { $limit: 50 }, // Đã ẩn limit để biểu đồ vẽ được toàn bộ dữ liệu trong ngày
            { $lookup: { from: 'students', localField: 'uid', foreignField: 'uid', as: 'studentInfo' } }
        ]);

        const formattedLogs = logs.map(log => {
            const studentExists = log.studentInfo && log.studentInfo.length > 0;
            const fullName = studentExists ? log.studentInfo[0].fullName : null;
            let dynamicStatus = "Chưa đăng ký";
            
            if (studentExists) {
                const logDate = new Date(log.timestamp);
                const logTotalMinutes = (logDate.getHours() * 60) + logDate.getMinutes();
                if (logTotalMinutes <= (shiftTotalMinutes + shiftConfig.lateThreshold)) {
                    dynamicStatus = "Đúng giờ";
                } else {
                    dynamicStatus = "Đi muộn";
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
        res.status(500).json({ error: "Không thể lấy dữ liệu" });
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
        const shiftConfig = await Shift.findOne();
        const oldLogs = await AttendanceLog.find({ uid: uid });

        if (shiftConfig) {
            const [shiftHour, shiftMin] = shiftConfig.startTime.split(':').map(Number);
            const shiftTotalMinutes = (shiftHour * 60) + shiftMin;

            for (let log of oldLogs) {
                const logTime = new Date(log.timestamp);
                const logTotalMinutes = logTime.getHours() * 60 + logTime.getMinutes();

                log.status = logTotalMinutes <= (shiftTotalMinutes + shiftConfig.lateThreshold) ? "Đúng giờ" : "Đi muộn";
                await log.save();
            }
        }

        console.log(`[Đăng ký mới] Kích hoạt thẻ ${uid} cho ${fullName}`);
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

// API lấy cấu hình ca hiện tại
app.get('/api/settings/shift', async (req, res) => {
    try {
        const shift = await Shift.findOne();
        res.json(shift);
    } catch (err) { res.status(500).json({ error: "Lỗi Server" }); }
});

// API cập nhật cấu hình ca
app.put('/api/settings/shift', async (req, res) => {
    try {
        const { shiftName, startTime, endTime, lateThreshold } = req.body;
        let shift = await Shift.findOne();
        if (shift) {
            shift.shiftName = shiftName;
            shift.startTime = startTime;
            shift.endTime = endTime;
            shift.lateThreshold = Number(lateThreshold) || 0;
            await shift.save();
        }
        res.json({ message: "Cập nhật cấu hình thành công!", shift });
    } catch (err) { res.status(500).json({ error: "Lỗi lưu cấu hình" }); }
});

// API xuất báo cáo ra file Excel
app.get('/api/report/excel', async (req, res) => {
    try {
        // 1. Lấy toàn bộ log và thông tin sinh viên liên quan
        const logs = await AttendanceLog.aggregate([
            { $sort: { timestamp: -1 } },
            { $lookup: { from: 'students', localField: 'uid', foreignField: 'uid', as: 'studentInfo' } }
        ]);

        const shiftConfig = await Shift.findOne();

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

            if (studentExists && shiftConfig) {
                const logTime = new Date(log.timestamp);
                const logTotalMinutes = logTime.getHours() * 60 + logTime.getMinutes();
                const [shiftHour, shiftMin] = shiftConfig.startTime.split(':').map(Number);
                const shiftTotalMinutes = (shiftHour * 60) + shiftMin;
                dynamicStatus = logTotalMinutes <= (shiftTotalMinutes + shiftConfig.lateThreshold) ? "Đúng giờ" : "Đi muộn";
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

// 5. KHỞI CHẠY SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend Server đã mở cửa tại cổng ${PORT}`);
    console.log(`👉 Chấp nhận kết nối từ mọi thiết bị (0.0.0.0)`);
});
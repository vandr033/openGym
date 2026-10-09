import Foundation
import Capacitor
import HealthKit

@objc(HealthKitPlugin)
public class HealthKitPlugin: CAPPlugin {
    private let store = HKHealthStore()
    private let iso = ISO8601DateFormatter()

    private var readTypes: Set<HKObjectType> {
        let quantities: [HKQuantityTypeIdentifier] = [
            .stepCount, .activeEnergyBurned, .appleExerciseTime, .bodyMass,
            .restingHeartRate, .heartRateVariabilitySDNN, .heartRate
        ]
        let types: [HKObjectType] = quantities.map { HKObjectType.quantityType(forIdentifier: $0)! }
        return Set(types + [
            HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!, HKObjectType.workoutType()
        ])
    }

    @objc func availability(_ call: CAPPluginCall) {
        call.resolve(["available": HKHealthStore.isHealthDataAvailable()])
    }

    @objc func requestAccess(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.reject("Apple Health is unavailable on this device"); return }
        // A successful request only means the sheet completed. Apple does not reveal read grants.
        store.requestAuthorization(toShare: [], read: readTypes) { _, error in
            if let error = error { call.reject(error.localizedDescription) }
            else { call.resolve() }
        }
    }

    @objc func getData(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.reject("Apple Health is unavailable on this device"); return }
        guard let from = call.getString("from"), let to = call.getString("to"),
              let start = ISO8601DateFormatter.healthDate(from), let end = ISO8601DateFormatter.healthDate(to),
              start < end else { call.reject("Invalid date range"); return }
        Task {
            do {
                let calendar = Calendar.current
                let dayStart = calendar.startOfDay(for: start)
                let dayEnd = calendar.startOfDay(for: end)
                var stats = [[String: Any]]()
                for (id, name, unit) in [
                    (HKQuantityTypeIdentifier.stepCount, "steps", HKUnit.count()),
                    (.activeEnergyBurned, "activeEnergyKcal", HKUnit.kilocalorie()),
                    (.appleExerciseTime, "exerciseMinutes", HKUnit.minute())
                ] {
                    stats += try await dailyStats(id, name: name, unit: unit, from: dayStart, to: dayEnd)
                }
                var samples = [[String: Any]]()
                for (id, name, unit) in [
                    (HKQuantityTypeIdentifier.bodyMass, "bodyMass", HKUnit.gramUnit(with: .kilo)),
                    (.restingHeartRate, "restingHeartRate", HKUnit.count().unitDivided(by: .minute())),
                    (.heartRateVariabilitySDNN, "heartRateVariabilitySDNN", HKUnit.secondUnit(with: .milli)),
                    (.heartRate, "heartRate", HKUnit.count().unitDivided(by: .minute()))
                ] {
                    let found = try await query(HKObjectType.quantityType(forIdentifier: id)!, from: start, to: end)
                    samples += found.compactMap { object -> [String: Any]? in
                        guard let s = object as? HKQuantitySample else { return nil }
                        return ["id": s.uuid.uuidString, "type": name, "value": s.quantity.doubleValue(for: unit),
                                "startAt": iso.string(from: s.startDate), "endAt": iso.string(from: s.endDate)]
                    }
                }
                let sleepFound = try await query(HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!, from: start, to: end)
                let sleep = sleepFound.compactMap { object -> [String: Any]? in
                    guard let s = object as? HKCategorySample else { return nil }
                    let stages = ["inBed", "asleep", "awake", "core", "deep", "rem"]
                    guard stages.indices.contains(s.value) else { return nil }
                    return ["id": s.uuid.uuidString, "stage": stages[s.value],
                            "startAt": iso.string(from: s.startDate), "endAt": iso.string(from: s.endDate)]
                }
                let workoutFound = try await query(HKObjectType.workoutType(), from: start, to: end)
                let workouts = workoutFound.compactMap { object -> [String: Any]? in
                    guard let w = object as? HKWorkout else { return nil }
                    var item: [String: Any] = ["id": w.uuid.uuidString, "workoutType": String(describing: w.workoutActivityType),
                                               "startAt": iso.string(from: w.startDate), "endAt": iso.string(from: w.endDate),
                                               "durationSeconds": w.duration]
                    if let energy = w.totalEnergyBurned { item["activeEnergyKcal"] = energy.doubleValue(for: .kilocalorie()) }
                    return item
                }
                call.resolve(["stats": stats, "samples": samples, "sleep": sleep, "workouts": workouts])
            } catch { call.reject(error.localizedDescription) }
        }
    }

    private func query(_ type: HKSampleType, from: Date, to: Date) async throws -> [HKSample] {
        try await withCheckedThrowingContinuation { continuation in
            let predicate = HKQuery.predicateForSamples(withStart: from, end: to, options: [])
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
                if let error = error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: samples ?? []) }
            }
            store.execute(query)
        }
    }

    private func dailyStats(_ id: HKQuantityTypeIdentifier, name: String, unit: HKUnit, from: Date, to: Date) async throws -> [[String: Any]] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsCollectionQuery(quantityType: HKObjectType.quantityType(forIdentifier: id)!,
                quantitySamplePredicate: nil, options: .cumulativeSum, anchorDate: from,
                intervalComponents: DateComponents(day: 1))
            query.initialResultsHandler = { _, collection, error in
                if let error = error { continuation.resume(throwing: error); return }
                var rows = [[String: Any]]()
                let format = DateFormatter()
                format.calendar = Calendar.current
                format.dateFormat = "yyyy-MM-dd"
                collection?.enumerateStatistics(from: from, to: to) { stat, _ in
                    if let value = stat.sumQuantity()?.doubleValue(for: unit) {
                        rows.append(["type": name, "date": format.string(from: stat.startDate), "value": value])
                    }
                }
                continuation.resume(returning: rows)
            }
            store.execute(query)
        }
    }
}

private extension ISO8601DateFormatter {
    static func healthDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
